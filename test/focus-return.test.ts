import { expect, test, vi } from "vitest";
import { ComputerSession, type DriverResult, type Driver } from "../src/session.ts";

// The native focus-return marker is a machine contract; its explanation is prose.
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
  return { status: result.details.status, state: result.details.state };
}

test.each([
  "kept_for_popup", "kept_for_unconfirmed_read", "human_window_gone", "refused",
  "restored", "human_moved", "other_window",
])("preserves the native %s focus outcome without parsing its explanation", async outcome => {
  const result = await click(`focus_return: ${outcome} window_id=300; arbitrary explanation`);
  expect(result.status).toBe("delivered");
  expect(result.state?.focus_return).toBe(outcome);
});

test.each(["", "focus_return: future_reason window_id=300; arbitrary explanation"])(
  "does not infer a known focus outcome from an absent or unsupported marker: %s", async line => {
    const result = await click(line);
    expect(result.status).toBe("delivered");
    expect(result.state).not.toHaveProperty("focus_return");
  },
);
