import { expect, test, vi } from "vitest";
import { ComputerSession, type DriverResult, type Driver } from "../src/session.ts";

// LPT-955: the driver checks which window a real press at a point reaches and refuses before pressing when another
// window covers it. The receipt names that window, its address and how it relates to the target.
const target = { pid: 42, window_id: 100 };
const covering = { pid: 42, window_id: 200 };
function fixture(refusal: DriverResult, mode: "yolo" | "safe" = "yolo") {
  let windows: object[] = [];
  const driver: Driver = {
    identity: vi.fn(async window => `${window.pid}:${window.window_id}`),
    call: vi.fn<Driver["call"]>(async name => {
      if (name === "list_windows") return { content: [], structuredContent: { windows } };
      if (name === "list_apps") return { content: [], structuredContent: { apps: [{ name: "Pad", launch_path: "C:\\Pad\\pad.exe" }] } };
      if (name === "launch_app") windows = [{ ...target, title: "Pad" }];
      if (name === "launch_app") return { content: [{ type: "text", text: JSON.stringify({ pid: 42, windows: [{ ...target, title: "Pad" }] }) }] };
      if (name === "get_window_state") return { content: [{ type: "image", mimeType: "image/png", data: "cG5n" }],
        structuredContent: { snapshot_id: "s1", screenshot_width: 400, screenshot_height: 300, elements: [] } };
      return refusal;
    }),
    close: vi.fn(async () => {}),
  };
  return new ComputerSession(driver, () => mode);
}
const covered = (relation: string, title: string) => `pointer_target_occluded: screen point (310,220) is covered by x: window_id=${covering.window_id} pid=${covering.pid} relation=${relation} title=${JSON.stringify(title)}; nothing was pressed there`;
async function click(session: ComputerSession) {
  const opened = await session.open("Pad");
  return session.act({ window_ref: opened.details.window_ref!, observation_id: opened.details.observation_id!, delivery_mode: "foreground", action: "click", x: 10, y: 10 });
}
const message = (result: Awaited<ReturnType<typeof click>>) => result.content.filter(block => block.type === "text").map(block => block.text).join("\n");

test("a click under the target's own dialog refuses and names the dialog with its address", async () => {
  const session = fixture({ isError: true, content: [{ type: "text", text: covered("owned_window", "Change \"Foreground\" Color") }],
    structuredContent: { status: "refused", code: "pointer_target_occluded", effect: "refused" } });
  const result = await click(session);
  expect(result.details.status).toBe("refused");
  const text = message(result);
  expect(text).toMatch(/^Nothing was pressed: "Change "Foreground" Color" \(computer:window\/w-[0-9a-f-]+\), a window this window owns, covers the point\./);
  expect(text).toContain("It stays in front of this window even when this window is active.");
  // The named address is a window this session can read and act on.
  const occluder = /computer:window\/(w-[0-9a-f-]+)/.exec(text)![1];
  expect(session.windowTarget(occluder)).toEqual(covering);
});

test("a drag or timeline under another app's window refuses the same way", async () => {
  const session = fixture({ isError: true, content: [{ type: "text", text: `Windows held path: 0/3 points, pressed=false, released=false. ${covered("other_process", "Overlay")}` }],
    structuredContent: { code: "pointer_target_occluded", effect: "refused" } });
  const result = await click(session);
  expect(result.details.status).toBe("refused");
  expect(message(result)).toMatch(/^Nothing was pressed: a window of another app, "Overlay" \(computer:window\/w-[0-9a-f-]+\), covers the point\./);
});

test("another window of the same app is named as such", async () => {
  const session = fixture({ isError: true, content: [{ type: "text", text: covered("same_process", "Layers") }],
    structuredContent: { status: "refused", code: "pointer_target_occluded", effect: "refused" } });
  expect(message(await click(session))).toMatch(/^Nothing was pressed: another window of this app, "Layers" \(computer:window\//);
});

test("Safe mode names the covering window without granting it an address", async () => {
  const session = fixture({ isError: true, content: [{ type: "text", text: covered("other_process", "Overlay") }],
    structuredContent: { status: "refused", code: "pointer_target_occluded", effect: "refused" } }, "safe");
  const result = await click(session);
  expect(result.details.status).toBe("refused");
  expect(message(result)).toMatch(/^Nothing was pressed: a window of another app, "Overlay", covers the point\./);
});

test("a timeline that stops at a covered press after earlier events stays unknown and says where it stopped", async () => {
  const summary = `Input timeline: 2/5 events sent in 80 ms; everything held released: true. ${covered("other_process", "Overlay")}`;
  // The driver publishes a partial delivery as its action record: effect partial, with the summary text.
  const session = fixture({ content: [{ type: "text", text: summary }],
    structuredContent: { delivery: { delivered_count: 2, mode: "foreground" }, effect: "partial", route: "global_input", summary } });
  // A partial delivery carries no refusal; the receipt names the covering window above the usual guidance.
  const result = await click(session);
  expect(result.details.status).toBe("unknown");
  expect(message(result)).toMatch(/^A press stopped: a window of another app, "Overlay" \(computer:window\/w-[0-9a-f-]+\), covers the point\..*\nDriver returned unknown/s);
});
