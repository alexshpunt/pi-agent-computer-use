import { afterAll, expect, test } from "vitest";
import { connectLive, nativeForm, openWindow, text, WINDOWS_POWERSHELL_PATH } from "./remote.ts";
import type { ComputerResult } from "../../src/session.ts";

// Conditional foreground return must not redirect an unread pointer prefix.
// A disposable WinForms window stands in for the human; no physical press clears
// the driver's remembered input uncertainty during these checks.
const live = await connectLive();
const stamp = Date.now();
const opened: number[] = [];
afterAll(async () => { for (const pid of opened) await live.kill(pid); await live.close(); });

const user32 = `Add-Type -Name F -Namespace PiFocus -MemberDefinition '[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); [DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, uint f, UIntPtr e);'`;
const foreground = async () => Number((await live.powershell(`${user32}; [PiFocus.F]::GetForegroundWindow().ToInt64()`)).trim());
/** Bring a window to the front the way a person's click would, without counting as a physical press. */
const activate = (hwnd: number) => live.powershell(`${user32}; [PiFocus.F]::keybd_event(0xFC, 0, 0, [UIntPtr]::Zero); [PiFocus.F]::keybd_event(0xFC, 0, 2, [UIntPtr]::Zero); [void][PiFocus.F]::SetForegroundWindow([IntPtr]${hwnd})`);

async function form(title: string) {
  const window = await openWindow(live, live.machine, WINDOWS_POWERSHELL_PATH, nativeForm(title), title);
  const row = ((await live.search(live.windows, title) as ComputerResult).details.state?.windows as Record<string, unknown>[])[0];
  opened.push(row.pid as number);
  return { window, hwnd: row.window_id as number };
}
type Element = { role: string; name: string | null; bounds: { window_image?: { x: number; y: number; width: number; height: number } } };
/** A real click at the center of an element: what the agent does for something it sees only as pixels. */
async function clickAt(window: string, role: string, name: string) {
  const view = await live.read(window, ["full"]);
  const found = (view.details.ui!.elements as Element[]).find(e => e.role === role && e.name === name);
  const box = found?.bounds.window_image;
  if (!box) throw new Error(`${window} has no ${role} ${name} with image bounds`);
  return live.insert(`computer:observation/${view.details.observation_id}?delivery=foreground`,
    { action: "click", x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) });
}
/** Real key input into whatever has the keyboard focus in the window. */
async function keys(window: string, command: Record<string, unknown>) {
  const view = await live.read(window, ["image"]);
  return live.insert(`computer:observation/${view.details.observation_id}?delivery=foreground`, command);
}

// One human window for the whole file: the driver remembers it between actions, and these checks press no
// physical key or button that would tell it the human moved to another window.
let human: Awaited<ReturnType<typeof form>>;

test("pointer input and later typing retain the target while the earlier read is unconfirmed", async () => {
  human = await form(`pi-human-${stamp}`);
  const agent = await form(`pi-agent-${stamp}`);
  await activate(human.hwnd);
  expect(await foreground()).toBe(human.hwnd);
  for (let round = 0; round < 5; round++) {
    const clicked = await clickAt(agent.window, "Button", `Count ${round}`);
    expect(clicked.details.status, text(clicked)).toBe("delivered");
    expect(await foreground(), `after click ${round}`).toBe(agent.hwnd);
    expect(clicked.details.state?.focus_return).toBe("kept_for_unconfirmed_read");
  }
  // Typing into the clicked field must not acknowledge the earlier pointer stream.
  const field = await clickAt(agent.window, "Edit", "Field");
  expect(field.details.status, text(field)).toBe("delivered");
  expect(await foreground(), "after clicking the field").toBe(agent.hwnd);
  const typed = await keys(agent.window, { action: "type_text", text: "agent text" });
  expect(typed.details.status, text(typed)).toBe("delivered");
  expect(await foreground(), "after typing").toBe(agent.hwnd);
  expect(typed.details.state?.focus_return).toBe("kept_for_unconfirmed_read");
  const view = await live.read(agent.window, ["full"]);
  const elements = JSON.stringify(view.details.ui!.elements);
  expect(elements).toContain("Count 5");
  expect(elements).toContain("agent text");
});

test("Paint menus stay open and closing them retains Paint while earlier pointer input is unconfirmed", async () => {
  expect(human, "the first check opens the human's window").toBeTruthy();
  const paint = await live.insert(live.machine, { action: "open", app: "Paint" });
  expect(paint.details.status, text(paint)).toBe("observed");
  opened.push(paint.details.target!.pid);
  const window = `computer:window/${paint.details.window_ref}`;
  const paintWindow = paint.details.target!.window_id;
  await activate(human.hwnd);
  const seen = new Set<number>();
  for (let round = 0; round < 20; round++) {
    const open = await clickAt(window, "MenuItem", ["File", "Edit", "View"][round % 3]);
    expect(open.details.status, text(open)).toBe("delivered");
    expect(open.details.state?.focus_return, `round ${round}`).toBe("kept_for_popup");
    const front = await foreground();
    seen.add(front);
    expect(front, `menu open, round ${round}`).not.toBe(human.hwnd);
    const close = await keys(window, { action: "key", key: "escape" });
    expect(close.details.status, text(close)).toBe("delivered");
    expect(await foreground(), `menu closed, round ${round}`).toBe(paintWindow);
    expect(close.details.state?.focus_return, `round ${round}`).toBe("kept_for_unconfirmed_read");
  }
  // While a menu was open, only Paint or its own popups were in front.
  console.log("foreground while menus were open", [...seen], "paint", paintWindow);
  for (const hwnd of seen) expect(await ownerPid(hwnd), `window ${hwnd}`).toBe(paint.details.target!.pid);
});

const ownerPid = async (hwnd: number) => Number((await live.powershell(`Add-Type -Name P -Namespace PiFocus -MemberDefinition '[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);'; $p = 0; [void][PiFocus.P]::GetWindowThreadProcessId([IntPtr]${hwnd}, [ref]$p); $p`)).trim());
