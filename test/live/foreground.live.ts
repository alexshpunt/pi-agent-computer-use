import { afterAll, expect, test } from "vitest";
import { addresses, connectLive, text } from "./remote.ts";
import type { ComputerResult } from "../../src/session.ts";

// LPT-829: foreground input to Paint must never bring another window forward.
// A disposable WinForms window stands in for the user's window behind Paint.
const live = await connectLive();
const title = `pi-behind-fixture-${Date.now()}`;
const opened: number[] = [];
afterAll(async () => { for (const pid of opened) await live.kill(pid); await live.close(); });

const foreground = async () => Number((await live.powershell(`Add-Type -Name F -Namespace PiLive -MemberDefinition '[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();'; [PiLive.F]::GetForegroundWindow().ToInt64()`)).trim());

test("opening and closing Paint menus 20 times never brings another window forward", async () => {
  live.powershell(`Add-Type -AssemblyName System.Windows.Forms; $f = New-Object Windows.Forms.Form; $f.Text = '${title}'; [void]$f.ShowDialog()`).catch(() => undefined);
  let behind: Record<string, unknown> | undefined;
  for (let i = 0; i < 20 && !behind; i++) {
    await new Promise(resolve => setTimeout(resolve, 500));
    behind = ((await live.search(live.windows, title) as ComputerResult).details.state?.windows as Record<string, unknown>[] ?? [])[0];
  }
  expect(behind).toBeTruthy();
  opened.push(behind!.pid as number);
  const paint = await live.insert(live.machine, { action: "open", app: "Paint" });
  expect(paint.details.status, text(paint)).toBe("observed");
  opened.push(paint.details.target!.pid);
  const window = `computer:window/${paint.details.window_ref}`;
  const seen = new Set<number>();
  for (let round = 0; round < 20; round++) {
    const view = await live.read(window, ["full"]);
    const menu = (view.details.ui!.elements as { hint: string; role: string; name: string }[]).find(e => e.role === "MenuItem" && e.name === ["File", "Edit", "View"][round % 3])!;
    const open = await live.insert(`computer:observation/${view.details.observation_id}?hint=${encodeURIComponent(menu.hint)}&delivery=foreground`, { action: "click" });
    expect(open.details.status, text(open)).toBe("delivered");
    seen.add(await foreground());
    const after = await live.read(window, ["image"]);
    const close = await live.insert(`computer:observation/${after.details.observation_id}?delivery=foreground`, { action: "key", key: "escape" });
    expect(close.details.status, text(close)).toBe("delivered");
    seen.add(await foreground());
  }
  console.log("foreground windows seen", [...seen], "behind", behind!.window_id);
  expect(seen.has(behind!.window_id as number)).toBe(false);
});
