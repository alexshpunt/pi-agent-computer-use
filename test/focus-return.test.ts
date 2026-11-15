import { expect, test, vi } from "vitest";
import { ComputerSession, type DriverResult, type Driver } from "../src/session.ts";

// LPT-1540: after foreground input the driver hands the foreground back to the human's window. When it leaves the
// foreground with the target, its result has a `focus_return:` line, and the receipt says why.
const target = { pid: 42, window_id: 100 };
function fixture(result: DriverResult) {
  let windows: object[] = [];
  const driver: Driver = {
    identity: vi.fn(async window => `${window.pid}:${window.window_id}`),
    call: vi.fn<Driver["call"]>(async name => {
      if (name === "list_windows") return { content: [], structuredContent: { windows } };
      if (name === "list_apps") return { content: [], structuredContent: { apps: [{ name: "Pad", launch_path: "C:\\Pad\\pad.exe" }] } };
      if (name === "launch_app") {
        windows = [{ ...target, title: "Pad" }];
        return { content: [{ type: "text", text: JSON.stringify({ pid: 42, windows }) }] };
      }
      if (name === "get_window_state") return { content: [{ type: "image", mimeType: "image/png", data: "cG5n" }],
        structuredContent: { snapshot_id: "s1", screenshot_width: 400, screenshot_height: 300, elements: [] } };
      return result;
    }),
    close: vi.fn(async () => {}),
  };
  return new ComputerSession(driver, () => "yolo");
}
async function click(line: string) {
  const session = fixture({ content: [{ type: "text", text: "✅ Sent click via SendInput to pid 42 at (310,220) (delivery_mode:foreground)." }, { type: "text", text: line }],
    structuredContent: { delivery: { mode: "foreground" }, effect: "unverifiable", route: "global_input" } });
  const opened = await session.open("Pad");
  const result = await session.act({ window_ref: opened.details.window_ref!, observation_id: opened.details.observation_id!, delivery_mode: "foreground", action: "click", x: 10, y: 10 });
  return { status: result.details.status, text: result.content.filter(block => block.type === "text").map(block => block.text).join("\n") };
}

test("a menu the click opened keeps the foreground with the window, and the receipt says so", async () => {
  const result = await click("focus_return: kept_for_popup window_id=300; a menu or popup of the target is open, so the target keeps the foreground until an action closes it.");
  expect(result.status).toBe("delivered");
  expect(result.text).toMatch(/^This window keeps the foreground while a menu or popup of it is open; the human's window gets it back after an action closes it\.\nDriver returned delivered/);
});

test("a closed or minimized human window is named as the reason", async () => {
  const result = await click("focus_return: human_window_gone window_id=7; the human's last window is closed, hidden, minimized or on another desktop, so the target keeps the foreground.");
  expect(result.text).toMatch(/^This window keeps the foreground: the human's last window is closed, hidden, minimized or on another desktop\.\n/);
});

test("a foreground handed back to the human needs no words", async () => {
  const result = await click("focus_return: restored window_id=7 title=\"Notepad\"; the human's window is in front again.");
  expect(result.text).toMatch(/^Driver returned delivered/);
  expect(result.text).not.toContain("keeps the foreground");
});
