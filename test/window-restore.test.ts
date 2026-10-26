import { expect, test, vi } from "vitest";
import { ComputerSession, type ComputerMode, type Driver, type DriverResult } from "../src/session.ts";
import { ComputerResources, requireComputerAddress } from "../src/computer-resources.ts";
import { computerSource } from "../src/computer-address.ts";

async function fixture() {
  let mode: ComputerMode = "yolo", life: string | undefined = "life", serial = 0;
  let capability = true, afterStatus: (() => void) | undefined, afterRestore: (() => void) | undefined;
  let receipt: Partial<Record<string, unknown>> = {}, error = false;
  const driver: Driver = {
    get windowRestore() { return capability; },
    identity: vi.fn(async () => life), close: vi.fn(async () => {}),
    call: vi.fn<Driver["call"]>(async (name, args): Promise<DriverResult> => {
      if (name === "list_windows") return { content: [], structuredContent: { windows: [{ pid: 42, window_id: 91, minimized: true }] } };
      if (name === "get_window_status") {
        const state = { pid: 42, window_id: 91, state_id: `native-${++serial}`, minimized: true,
          visible: true, foreground_at_target: false, keyboard_focus_at_target: null };
        afterStatus?.();
        return { content: [], structuredContent: state };
      }
      if (name === "get_window_state") return { content: [], structuredContent: { pid: 42, window_id: 91,
        snapshot_id: "ui", elements: [], elements_complete: true } };
      if (name === "restore_window") {
        afterRestore?.();
        return { content: [], isError: error, structuredContent: {
          ...args, route: "native", effect: "confirmed", restore_attempted: true, restore_requested: true,
          restored: true, activation_attempted: true, activation_succeeded: true, visible: true,
          foreground_at_target: true, keyboard_focus_at_target: null, foreground_changed: true, ...receipt,
        } };
      }
      throw Error(`Unexpected native operation ${name}`);
    }),
  };
  const session = new ComputerSession(driver, () => mode);
  const resources = new ComputerResources(async () => session, async () => session.close());
  const row = (sessionResult: Awaited<ReturnType<ComputerSession["windows"]>>) =>
    (sessionResult.details.state!.windows as { window_ref: string }[])[0];
  const window = requireComputerAddress(computerSource("window", row(await session.windows()).window_ref));
  const calls = () => vi.mocked(driver.call).mock.calls;
  const restores = () => calls().filter(([name]) => name === "restore_window");
  const read = async () => {
    const result = await resources.read(window, "/fixture", ["state"]);
    expect(result?.details.status).toBe("observed");
    expect(result?.content.some(block => block.type === "image")).toBe(false);
    return result!;
  };
  // computer_window restore: a fresh state sample bounds exactly one restore.
  const restore = (signal?: AbortSignal) => resources.manageWindow(window, "/fixture", { action: "restore" }, signal);
  return { driver, session, resources, window, calls, restores, read, restore,
    setLife(value: string | undefined) { life = value; }, setMode(value: ComputerMode) { mode = value; },
    setCapability(value: boolean) { capability = value; }, afterStatus(value: () => void) { afterStatus = value; },
    afterRestore(value: () => void) { afterRestore = value; },
    outcome(value: Record<string, unknown>, isError = false) { receipt = value; error = isError; } };
}

test("restore samples the window's state and restores exactly that window without pixels or UI", async () => {
  const f = await fixture();
  const result = await f.restore();
  expect(result.details.status).toBe("delivered");
  expect(f.restores()).toEqual([["restore_window", { pid: 42, window_id: 91, state_id: "native-1" }, undefined]]);
  expect(f.calls().filter(([name]) => name === "get_window_state")).toHaveLength(0);
  // Each restore samples its own state; nothing from an earlier call is reused.
  expect((await f.restore()).details.status).toBe("delivered");
  expect(f.restores().at(-1)).toEqual(["restore_window", { pid: 42, window_id: 91, state_id: "native-2" }, undefined]);
});

test("a state Read only looks: it hands out no state address and keeps the window's observations", async () => {
  const f = await fixture();
  const ui = await f.resources.read(f.window, "/fixture", ["ui"]);
  const view = await f.read();
  expect(view.content.map(block => block.type === "text" ? block.text : "").join("\n")).not.toMatch(/window-state|Insert/);
  const observation = requireComputerAddress(computerSource("observation", ui!.details.observation_id!));
  expect((await f.resources.read(observation, "/fixture", ["ui"]))?.details.status).toBe("observed");
  expect(() => requireComputerAddress(`computer:window-state/${view.details.window_state_id}`)).toThrow();
  expect(f.restores()).toHaveLength(0);
});

test.each(["safe", "closed", "reused"] as const)("%s window cannot be restored", async change => {
  const f = await fixture();
  if (change === "safe") f.setMode("safe"); else f.setLife(change === "closed" ? undefined : "new-life");
  expect((await f.restore()).details.status).toBe("refused");
  expect(f.restores()).toHaveLength(0);
});

test("a window reused during status acquisition is not restored", async () => {
  const f = await fixture(); f.afterStatus(() => f.setLife("replacement-life"));
  expect((await f.restore()).details.status).toBe("refused");
  expect(f.restores()).toHaveLength(0);
});

test("cancellation before dispatch sends no native restore", async () => {
  const f = await fixture(), controller = new AbortController(); controller.abort();
  expect((await f.restore(controller.signal)).details.status).toBe("refused");
  expect(f.restores()).toHaveLength(0);
});

test.each([
  { activation_succeeded: false, foreground_at_target: false, effect: "unknown", code: "foreground_unavailable" },
  { restore_requested: true, restored: false, activation_attempted: false, activation_succeeded: false,
    foreground_at_target: null, effect: "unknown", code: "cancelled" },
])("partial restore/cancellation keeps unknown effects and never replays", async receipt => {
  const f = await fixture(); f.outcome(receipt, true);
  const result = await f.restore();
  expect(result.details.status).toBe("unknown");
  expect(result.details.state).toMatchObject({ restore_attempted: true, ...receipt });
  expect(f.restores()).toHaveLength(1);
});

test.each([{ window_id: 92 }, { state_id: "wrong-state" }, { foreground_at_target: null },
  { visible: false }, { activation_succeeded: false }, { route: "assisted" }, { effect: "unverifiable" }])(
  "malformed success never disguises incomplete restoration", async receipt => {
    const f = await fixture(); f.outcome(receipt);
    expect((await f.restore()).details.status).toBe("unknown");
    expect(f.restores()).toHaveLength(1);
  });

test("post-dispatch reuse preserves delivered native prefix as unknown", async () => {
  const f = await fixture();
  f.afterRestore(() => f.setLife("replacement-life"));
  const result = await f.restore();
  expect(result.details.status).toBe("unknown");
  expect(result.details.state).toMatchObject({ restore_requested: true, restored: true, activation_succeeded: true });
  expect(f.restores()).toHaveLength(1);
});
test("unqualified runtime gives a concrete human restore route without fallback", async () => {
  const f = await fixture(); f.setCapability(false);
  const result = await f.resources.read(f.window, "/fixture", ["state"]);
  expect(result?.details.status).toBe("refused");
  expect(result?.content.filter(block => block.type === "text").map(block => block.text).join("\n")).toMatch(/manually|user/i);
  expect(f.calls().map(([name]) => name)).toEqual(["list_windows"]);
});
