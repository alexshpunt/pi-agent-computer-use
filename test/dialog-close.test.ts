import { expect, test, vi } from "vitest";
import { ComputerSession, type DriverResult, type Driver } from "../src/session.ts";

// LPT-954: a click that closes its window, such as OK in a dialog, hands the foreground to another window of the app.
// The driver reports that window as foreground_after; the receipt is delivered and names it.
const dialog = { pid: 42, window_id: 100 };
const main = { pid: 42, window_id: 200 };
function fixture(click: DriverResult, mode: "yolo" | "safe" = "yolo") {
  let windows: object[] = [];
  const driver: Driver = {
    identity: vi.fn(async window => `${window.pid}:${window.window_id}`),
    call: vi.fn<Driver["call"]>(async name => {
      if (name === "list_windows") return { content: [], structuredContent: { windows } };
      if (name === "list_apps") return { content: [], structuredContent: { apps: [{ name: "Editor", launch_path: "C:\\Editor\\editor.exe" }] } };
      if (name === "launch_app") windows = [{ ...dialog, title: "Create a New Image" }];
      if (name === "launch_app") return { content: [{ type: "text", text: JSON.stringify({ pid: 42, windows }) }] };
      if (name === "get_window_state") return { content: [{ type: "image", mimeType: "image/png", data: "cG5n" }],
        structuredContent: { snapshot_id: "s1", screenshot_width: 400, screenshot_height: 300, elements: [] } };
      return click;
    }),
    close: vi.fn(async () => {}),
  };
  return new ComputerSession(driver, () => mode);
}
async function clickOk(session: ComputerSession) {
  const opened = await session.open("Editor");
  return session.act({ window_ref: opened.details.window_ref!, observation_id: opened.details.observation_id!, delivery_mode: "foreground", action: "click", x: 350, y: 250 });
}
const closed = { content: [{ type: "text" as const, text: "✅ Sent click via SendInput to pid 42 at (350,340) (delivery_mode:foreground)." },
  { type: "text" as const, text: "The click closed its target; window 200 of the same process is now in front: \"Untitled - Editor\"." }],
  structuredContent: { path: "pixel", verified: false, effect: "unverifiable", foreground_after: { ...main, title: "Untitled - Editor" } } };
const message = (result: Awaited<ReturnType<typeof clickOk>>) => result.content.filter(block => block.type === "text").map(block => block.text).join("\n");

test("a click that closes its window is delivered and names the window of the app now in front", async () => {
  const session = fixture(closed);
  const result = await clickOk(session);
  expect(result.details.status, message(result)).toBe("delivered");
  expect(message(result)).toMatch(/^The click closed this window; "Untitled - Editor" \(computer:window\/(w-[0-9a-f-]+)\) of the same app is now in front\./);
  const ref = /computer:window\/(w-[0-9a-f-]+)/.exec(message(result))![1];
  expect(session.windowTarget(ref)).toEqual(main);
});

test("Safe mode names the window now in front without granting it an address", async () => {
  const result = await clickOk(fixture(closed, "safe"));
  expect(result.details.status).toBe("delivered");
  expect(message(result)).toMatch(/^The click closed this window; "Untitled - Editor" of the same app is now in front\./);
});

test("after input, a window that closed or hid names the app's frontmost remaining window", async () => {
  let windows: object[] = [];
  const driver: Driver = {
    identity: vi.fn(async window => `${window.pid}:${window.window_id}`),
    call: vi.fn<Driver["call"]>(async name => {
      if (name === "list_windows") return { content: [], structuredContent: { windows } };
      if (name === "list_apps") return { content: [], structuredContent: { apps: [{ name: "Editor", launch_path: "C:\\Editor\\editor.exe" }] } };
      if (name === "launch_app") windows = [{ ...dialog, title: "Create a New Image" }];
      if (name === "launch_app") return { content: [{ type: "text", text: JSON.stringify({ pid: 42, windows }) }] };
      return { content: [{ type: "image", mimeType: "image/png", data: "cG5n" }], structuredContent: { snapshot_id: "s1", elements: [] } };
    }),
    close: vi.fn(async () => {}),
  };
  const session = new ComputerSession(driver, () => "yolo");
  await session.open("Editor");
  // While the window is listed, nothing is said.
  expect(await session.closedWindowNote(dialog)).toBeUndefined();
  // Listing order is the desktop's z-order, front first.
  windows = [{ pid: 7, window_id: 300, title: "Other app" }, { ...main, title: "Untitled - Editor" }, { pid: 42, window_id: 201, title: "Layers" }];
  expect(await session.closedWindowNote(dialog)).toMatch(/^This window closed or is hidden; the app's frontmost window is "Untitled - Editor" \(computer:window\/w-[0-9a-f-]+\)\.$/);
  windows = [{ pid: 7, window_id: 300, title: "Other app" }];
  expect(await session.closedWindowNote(dialog)).toBe("This window closed or is hidden; the app has no other visible window.");
});
