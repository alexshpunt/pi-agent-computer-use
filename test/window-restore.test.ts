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
    const source = computerSource("window-state", result!.details.window_state_id!);
    return { result: result!, address: requireComputerAddress(source), source };
  };
  const restore = (address: ReturnType<typeof requireComputerAddress>, signal?: AbortSignal) =>
    resources.perform(address, "/fixture", '{"action":"restore"}', "insert", signal);
  return { driver, session, resources, window, calls, restores, read, restore,
    setLife(value: string | undefined) { life = value; }, setMode(value: ComputerMode) { mode = value; },
    setCapability(value: boolean) { capability = value; }, afterStatus(value: () => void) { afterStatus = value; },
    afterRestore(value: () => void) { afterRestore = value; },
    outcome(value: Record<string, unknown>, isError = false) { receipt = value; error = isError; } };
}

test("fresh metadata-only Read authorizes one exact restore without acquiring pixels or UI", async () => {
  const f = await fixture(), view = await f.read();
  const before = f.calls().length;
  expect(f.resources.descriptor(view.address)).toContain("restore");
  expect(f.calls()).toHaveLength(before);
  const result = await f.restore(view.address);
  expect(result.details.status).toBe("delivered");
  expect(f.restores()).toEqual([["restore_window", { pid: 42, window_id: 91, state_id: "native-1" }, undefined]]);
  expect(f.calls().filter(([name]) => name === "get_window_state")).toHaveLength(0);
  await expect(f.restore(view.address)).rejects.toThrow(/expired|retired/i);
  expect(f.restores()).toHaveLength(1);
});

test("window state is not literal, pixel, token, sequence or caller-supplied identity authority", async () => {
  const f = await fixture(), view = await f.read();
  for (const [tool, value] of [["write", "hello"], ["insert", '{"action":"click","x":1,"y":1}'],
    ["insert", '{"action":"restore","window_id":92}'], ["insert", '{"action":"restore","state_id":"other"}'],
    ["insert", '{"action":"restore","delivery_mode":"foreground"}'], ["insert", '{"action":"sequence","sequence":[]}']] as const)
    await expect(f.resources.perform(view.address, "/fixture", value, tool)).rejects.toThrow();
  expect(f.restores()).toHaveLength(0);
  expect(f.calls().filter(([name]) => name === "get_window_status")).toHaveLength(1);
});

test("fresh window parts retire old state, and state Read retires old UI authority", async () => {
  const f = await fixture(), first = await f.read(), next = await f.read();
  await expect(f.restore(first.address)).rejects.toThrow(/expired|retired/i);
  const ui = await f.resources.read(f.window, "/fixture", ["ui"]);
  await expect(f.restore(next.address)).rejects.toThrow(/expired|retired/i);
  const observation = requireComputerAddress(computerSource("observation", ui!.details.observation_id!));
  await f.read();
  await expect(f.resources.perform(observation, "/fixture", "text", "write")).rejects.toThrow(/expired|retired/i);
  expect(f.restores()).toHaveLength(0);
});

test.each(["safe", "closed", "reused"] as const)("%s state cannot dispatch or silently refresh restoration", async change => {
  const f = await fixture(), view = await f.read();
  if (change === "safe") f.setMode("safe"); else f.setLife(change === "closed" ? undefined : "new-life");
  expect((await f.restore(view.address)).details.status).toBe("refused");
  expect(f.restores()).toHaveLength(0);
  expect(f.calls().filter(([name]) => name === "get_window_status")).toHaveLength(1);
  await expect(f.restore(view.address)).rejects.toThrow(/expired|retired/i);
});

test("a window reused during status acquisition grants no state reference", async () => {
  const f = await fixture(); f.afterStatus(() => f.setLife("replacement-life"));
  const result = await f.resources.read(f.window, "/fixture", ["state"]);
  expect(result?.details.status).toBe("refused");
  expect(result?.details.window_state_id).toBeUndefined();
  expect(f.restores()).toHaveLength(0);
});

test("cancellation before dispatch consumes the explicit command without native restore", async () => {
  const f = await fixture(), view = await f.read(), controller = new AbortController(); controller.abort();
  expect((await f.restore(view.address, controller.signal)).details.status).toBe("refused");
  expect(f.restores()).toHaveLength(0);
  await expect(f.restore(view.address)).rejects.toThrow(/expired|retired/i);
});

test.each([
  { activation_succeeded: false, foreground_at_target: false, effect: "unknown", code: "foreground_unavailable" },
  { restore_requested: true, restored: false, activation_attempted: false, activation_succeeded: false,
    foreground_at_target: null, effect: "unknown", code: "cancelled" },
])("partial restore/cancellation keeps unknown effects and never replays", async receipt => {
  const f = await fixture(), view = await f.read(); f.outcome(receipt, true);
  const result = await f.restore(view.address);
  expect(result.details.status).toBe("unknown");
  expect(result.details.state).toMatchObject({ restore_attempted: true, ...receipt });
  await expect(f.restore(view.address)).rejects.toThrow(/expired|retired/i);
  expect(f.restores()).toHaveLength(1);
});

test.each([{ window_id: 92 }, { state_id: "wrong-state" }, { foreground_at_target: null },
  { visible: false }, { activation_succeeded: false }, { route: "assisted" }, { effect: "unverifiable" }])(
  "malformed success never disguises incomplete restoration", async receipt => {
    const f = await fixture(), view = await f.read(); f.outcome(receipt);
    expect((await f.restore(view.address)).details.status).toBe("unknown");
    expect(f.restores()).toHaveLength(1);
  });

test("cached state Read does not reacquire or renew restore authority", async () => {
  const f = await fixture(), view = await f.read();
  const cached = await f.resources.read(view.address, "/fixture");
  expect(cached?.details).toEqual(view.result.details);
  const cachedText = cached?.content.find(block => block.type === "text");
  const freshText = view.result.content.find(block => block.type === "text");
  expect(cachedText?.type === "text" && cachedText.text).toMatch(/^Cached native window state\./);
  expect(cachedText?.type === "text" && cachedText.text.slice(cachedText.text.indexOf("\n")))
    .toBe(freshText?.type === "text" && freshText.text.slice(freshText.text.indexOf("\n")));
  expect(f.calls().filter(([name]) => name === "get_window_status")).toHaveLength(1);
  await f.restore(view.address);
  await expect(f.resources.read(view.address, "/fixture")).rejects.toThrow(/expired|retired/i);
});

test.each(["safe", "reused"] as const)("cached %s state is withheld without reacquisition", async change => {
  const f = await fixture(), view = await f.read();
  if (change === "safe") f.setMode("safe"); else f.setLife("replacement-life");
  expect((await f.resources.read(view.address, "/fixture"))?.details.status).toBe("refused");
  expect(f.calls().filter(([name]) => name === "get_window_status")).toHaveLength(1);
  await expect(f.restore(view.address)).rejects.toThrow(/expired|retired/i);
});

test("post-dispatch reuse preserves delivered native prefix as unknown", async () => {
  const f = await fixture(), view = await f.read();
  f.afterRestore(() => f.setLife("replacement-life"));
  const result = await f.restore(view.address);
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
