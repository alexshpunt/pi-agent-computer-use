import { afterAll, expect, test } from "vitest";
import { computerSource } from "../../src/computer-address.ts";
import { clickPlan, dragPlan } from "../../src/computer-tools.ts";
import type { ComputerResult } from "../../src/session.ts";
import { at, connectLive, text } from "./remote.ts";

// LPT-630: an isolated agent session (MXC isolation_session) on the configured machine: its own desktop, apps and
// input, operated through ordinary Search/Read/Insert, and removed again on close.
const live = await connectLive();
const opened: string[] = [];
afterAll(async () => { for (const session of opened) await live.insert(session, { action: "close" }).catch(() => undefined); await live.close(); });

test("an isolated session opens, runs an app with foreground input and closes without leaving its agent user", async () => {
  const started = performance.now();
  const result = await live.insert(live.machine, { action: "open_session" });
  expect(result.details.status, text(result)).toBe("delivered");
  console.log(`opened in ${Math.round(performance.now() - started)} ms`);
  const session = computerSource("sandbox", result.details.sandbox_ref!);
  opened.push(session);
  const user = /Agent user: (\S+)/.exec(text(result))![1];

  const app = await live.insert(session, { action: "open", path: "C:\\Windows\\System32\\notepad.exe" });
  expect(app.details.status, text(app)).toBe("observed");
  expect(app.details.source_identity?.domain).toBe("windows-session");
  const window = `computer:window/${app.details.window_ref}`;
  const doc = "abcdefghijklmnopqrstuvwxyz";
  const read = () => live.read(window, ["full"]);
  const type = (view: ComputerResult, value: string) =>
    live.write(`computer:observation/${view.details.observation_id}?delivery=foreground`, value);
  const editor = (view: ComputerResult) => view.details.ui!.elements.find(e => e.role === "Edit" || e.role === "Document")!;
  const caret = (view: ComputerResult) => view.details.ui!.elements.find(e => /Ln 1, Col \d+/.test(e.name ?? ""))?.name?.trim();
  const editMenu = (view: ComputerResult) => view.details.ui!.elements.find(e => e.name === "Edit" && e.role === "MenuItem")!;
  const typed = await type(await read(), doc);
  expect(typed.details.status, text(typed)).toBe("delivered");
  const before = await read();
  expect(editor(before).value).toBe(doc);
  expect(caret(before)).toBe("Ln 1, Col 27");
  expect(editMenu(before).expanded).toBe(false);

  // Check the app, not just the driver's success response. A future driver may confirm delivery,
  // but the current headless WinStation can accept pointer input without it reaching this window.
  const checkPointer = (label: string, result: ComputerResult, changed: boolean) => {
    console.log(`${label}: ${result.details.status}; app state changed: ${changed}`);
    if (!changed || result.details.state?.effect !== "confirmed")
      expect(["unknown", "refused"], text(result)).toContain(result.details.status);
  };

  const bounds = editor(before).bounds.window_image!;
  const y = bounds.y + 9;
  const click = await live.resources.input(at(window), live.cwd, clickPlan({ window, x: bounds.x + 26, y }));
  const afterClick = await read();
  expect(caret(afterClick)).toMatch(/^Ln 1, Col \d+$/);
  checkPointer("editor point click", click, caret(afterClick) !== caret(before));

  const menu = editMenu(afterClick).bounds.window_image!;
  const menuClick = await live.resources.input(at(window), live.cwd,
    clickPlan({ window, x: menu.x + Math.floor(menu.width / 2), y: menu.y + Math.floor(menu.height / 2) }));
  let afterMenu = await read();
  const expanded = editMenu(afterMenu).expanded;
  expect(typeof expanded).toBe("boolean");
  checkPointer("Edit menu point click", menuClick, expanded === true);
  if (expanded) {
    const esc = await live.insert(`computer:observation/${afterMenu.details.observation_id}?delivery=foreground`, { action: "key", key: "escape" });
    expect(esc.details.status, text(esc)).toBe("delivered");
    afterMenu = await read();
    expect(editMenu(afterMenu).expanded).toBe(false);
  }

  const drag = await live.resources.input(at(window), live.cwd,
    dragPlan({ window, from: { x: bounds.x + 25, y }, to: { x: bounds.x + 100, y } }));
  // Typing replaces a drag selection, but adds exactly one character if nothing was selected.
  const afterDrag = await read();
  expect(editor(afterDrag).value).toBe(doc);
  const mark = await type(afterDrag, "#");
  expect(mark.details.status, text(mark)).toBe("delivered");
  const marked = editor(await read()).value!;
  expect(marked).toContain("#");
  checkPointer("editor drag selection", drag, marked.length < doc.length + 1);

  // The human's own windows are not this session's.
  const listed = await live.search(session, "regex:.");
  expect(JSON.stringify(listed.details.state)).not.toMatch(/Visual Studio Code|Telegram/);

  const closed = await live.insert(session, { action: "close" });
  expect(closed.details.status, text(closed)).toBe("closed");
  opened.pop();
  const left = await live.runner.run("bash", ["-c", `ls -d /mnt/c/Users/${user} 2>/dev/null || true`]);
  expect(left.trim()).toBe("");
});
