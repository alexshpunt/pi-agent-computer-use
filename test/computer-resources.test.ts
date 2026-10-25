import { expect, test, vi } from "vitest";
import sharp from "sharp";
import { computerSource } from "../src/computer-address.ts";
import { ComputerResources, requireComputerAddress } from "../src/computer-resources.ts";
import { ComputerSession, type ComputerMode, type Content, type Driver, type DriverResult } from "../src/session.ts";

const cwd = "/synthetic-computer-fixture";
const address = requireComputerAddress;
const inputNames = new Set(["type_text", "click", "press_key", "hotkey", "scroll", "drag", "semantic_action"]);

async function fixture() {
  let mode: ComputerMode = "yolo", lifetime: string | undefined = "native-life", serial = 0;
  let outcome: DriverResult = { content: [], structuredContent: { effect: "confirmed" } };
  let afterInput: (() => void) | undefined;
  let liveBounds = { x: 80, y: 90, width: 500, height: 320 };
  const raw = await sharp({ create: { width: 500, height: 320, channels: 3, background: "#eef4ff" } }).png().toBuffer();
  const image: Content = { type: "image", mimeType: "image/png", data: raw.toString("base64") };
  const jpeg: Content = { type: "image", mimeType: "image/jpeg", data: (await sharp(raw).extract({ left: 80, top: 60, width: 40, height: 20 }).jpeg().toBuffer()).toString("base64") };
  const driver: Driver = {
    identity: vi.fn(async () => lifetime), close: vi.fn(async () => {}),
    call: vi.fn<Driver["call"]>(async (name, args) => {
      if (name === "list_windows") return { content: [], structuredContent: { windows: [{ pid: 42, window_id: 91 }] } };
      if (name === "get_window_state") return { content: [image], structuredContent: {
        pid: 42, window_id: 91, snapshot_id: `snapshot-${++serial}`, capture_id: `capture-${serial}`,
        screenshot_width: 500, screenshot_height: 320, window_bounds: { x: 80, y: 90, width: 500, height: 320 },
        elements_complete: true, elements: [{ element_token: `snapshot-${serial}:0`, role: "Edit", label: "Text field", enabled: true,
          frame: { x: 160, y: 150, w: 40, h: 20 }, screenshot_frame: { x: 80, y: 60, w: 40, h: 20 } }],
      } };
      if (name === "get_desktop_state") return { content: [image], structuredContent: {
        display: "primary", platform: "windows", capture_id: "private-display-capture", screen_width: 500, screen_height: 320,
        screenshot_width: 500, screenshot_height: 320, screenshot_original_width: 500, screenshot_original_height: 320, scale_factor: 1,
      } };
      if (name === "get_window_control_state") return { content: [], structuredContent: { state: { bounds: liveBounds, minimized: false, visible: true } } };
      if (name === "zoom") return { content: [jpeg], structuredContent: { width: 40, height: 20, x_offset: 80, y_offset: 60 } };
      if (inputNames.has(name)) { afterInput?.(); return outcome; }
      throw Error(`Unexpected native call ${name}: ${JSON.stringify(args)}`);
    }),
  };
  const session = new ComputerSession(driver, () => mode);
  const resources = new ComputerResources(async () => session, async () => session.close());
  const listed = await session.windows();
  const ref = (listed.details.state!.windows as { window_ref: string }[])[0].window_ref;
  const window = address(computerSource("window", ref));
  const native = () => vi.mocked(driver.call).mock.calls;
  const inputs = () => native().filter(([name]) => inputNames.has(name));
  const captures = () => native().filter(([name]) => name === "get_window_state" || name === "get_desktop_state");
  const read = async (views?: string[]) => {
    const result = await resources.read(window, cwd, views);
    expect(result?.details.status).toBe("observed");
    const id = result!.details.observation_id!;
    return { result: result!, source: computerSource("observation", id), observation: address(computerSource("observation", id)), hint: result!.details.ui?.elements[0]?.hint };
  };
  return { session, resources, driver, window, native, inputs, captures, read,
    setMode(value: ComputerMode) { mode = value; }, setLifetime(value: string | undefined) { lifetime = value; },
    setOutcome(value: DriverResult) { outcome = value; }, afterInput(value: () => void) { afterInput = value; },
    setBounds(value: typeof liveBounds) { liveBounds = value; } };
}

test("literal Write preserves all text and descriptor/UI reads do not refresh native grounding", async () => {
  const f = await fixture(), view = await f.read(["ui"]);
  const before = f.native().length;
  expect(f.resources.descriptor(view.observation)).toContain(view.source);
  expect((await f.resources.read(view.observation, cwd, ["ui"]))?.details.observation_id).toBe(view.result.details.observation_id);
  expect((await f.resources.search(view.observation, cwd, "Text field"))?.details.status).toBe("observed");
  expect(f.native()).toHaveLength(before);
  const literal = '  {"looks":"like JSON"}\n"quoted text"\n  ';
  const target = address(`${view.source}?hint=${encodeURIComponent(view.hint!)}&delivery=foreground&delay_ms=0`);
  const written = await f.resources.perform(target, cwd, literal, "write");
  expect(written.details.status).toBe("delivered");
  // The only captures after input are the successor's UI walks; the unchanged fixture UI reads as no change.
  expect(written.details.successor?.diff?.counts).toEqual({ changed: 0, added: 0, removed: 0 });
  expect(written.details.successor?.diff?.waited_ms).toBeGreaterThanOrEqual(300);
  const captured = f.captures().length;
  expect(f.inputs()).toEqual([["type_text", {
    target: { kind: "window", pid: 42, window_id: 91 }, delivery_mode: "foreground",
    element_token: "snapshot-1:0", text: literal, delay_ms: 0,
  }, undefined]]);
  await expect(f.resources.perform(target, cwd, "replay", "write")).rejects.toThrow(/expired/i);
  expect(f.inputs()).toHaveLength(1); expect(f.captures()).toHaveLength(captured);
});

test.each(["refused", "unknown"] as const)("a native %s receipt consumes the provider handle without refreshing or replaying input", async status => {
  const f = await fixture(), view = await f.read(["ui"]);
  f.setOutcome({ isError: true, content: [{ type: "text", text: "Native outcome" }], structuredContent: { status } });
  const command = JSON.stringify({ action: "click", hint: view.hint });
  const result = await f.resources.perform(view.observation, cwd, command, "insert");
  expect(result.details.status).toBe(status);
  // A refusal sent nothing, so nothing is re-read; an unknown outcome gets a successor to show what may have happened.
  if (status === "refused") expect(f.captures()).toHaveLength(1);
  else expect(result.details.successor?.observation_id).toBeDefined();
  const captured = f.captures().length;
  await expect(f.resources.perform(view.observation, cwd, command, "insert")).rejects.toThrow(/expired/i);
  expect(f.inputs()).toHaveLength(1); expect(f.captures()).toHaveLength(captured);
});

test("cached observations reject acquisition options instead of pretending to apply them", async () => {
  const f = await fixture(), view = await f.read();
  for (const views of [['capture:{"max_elements":10}'], ['capture:{"hints":false}'], ['capture:{"maxLongEdge":320}']])
    await expect(f.resources.read(view.observation, cwd, views)).rejects.toThrow(/fresh window Read/i);
  expect(f.captures()).toHaveLength(1);
  expect((await f.resources.read(view.observation, cwd, ["ui"]))?.details.status).toBe("observed");
});

test("per-Read native cap is forwarded without changing the session defaults", async () => {
  const f = await fixture();
  await f.read(['capture:{"maxLongEdge":800,"scale":0.5}']);
  expect(f.captures().at(-1)?.[1]).toMatchObject({ max_image_dimension: 400 });
  await f.read();
  expect(f.captures().at(-1)?.[1]).toMatchObject({ max_image_dimension: 1280 });
  const before = f.captures().length;
  for (const views of [['capture:{"scale":0}'], ["ui", 'capture:{"maxLongEdge":800}']])
    await expect(f.resources.read(f.window, cwd, views)).rejects.toThrow();
  expect(f.captures()).toHaveLength(before);
});

test("temporal Read retires input authority and frame selection does not recapture", async () => {
  const f = await fixture(), view = await f.read();
  const captured = await f.resources.read(f.window, cwd, ['sequence:{"duration_ms":1,"max_frames":1}']);
  expect(captured?.details.sequence?.frames).toHaveLength(1);
  await expect(f.resources.perform(view.observation, cwd, "stale", "write")).rejects.toThrow(/expired/i);
  const sequence = address(computerSource("sequence", captured!.details.sequence!.sequence_id));
  const before = f.captures().length;
  const frames = await f.resources.read(sequence, cwd, ["frames:first"]);
  expect(frames?.content.some(block => block.type === "image")).toBe(true);
  expect(frames?.details.selected_frames?.[0].index).toBe(0);
  await expect(f.resources.perform(sequence, cwd, "not authority", "write")).rejects.toThrow(/observation address/i);
  expect(f.captures()).toHaveLength(before);
  expect(f.inputs()).toHaveLength(0);
});

test("a new overview retires the prior resource instead of rebinding its hint", async () => {
  const f = await fixture(), first = await f.read(["ui"]), latest = await f.read(["ui"]);
  expect(latest.source).not.toBe(first.source);
  await expect(f.resources.read(first.observation, cwd, ["ui"])).rejects.toThrow(/expired/i);
  await expect(f.resources.perform(first.observation, cwd, "stale", "write")).rejects.toThrow(/expired/i);
  expect(f.inputs()).toHaveLength(0);
  expect((await f.resources.perform(address(`${latest.source}?hint=${encodeURIComponent(latest.hint!)}`), cwd, "current", "write")).details.status).toBe("delivered");
  expect(f.inputs()[0][1]).toMatchObject({ element_token: "snapshot-2:0", text: "current" });
  // Two overviews, then only the successor's UI walks after the input.
  expect(f.captures().slice(2).every(([, args]) => (args as { include_screenshot?: boolean }).include_screenshot === false)).toBe(true);
});

test.each(["safe", "closed", "reused"] as const)("%s targets refuse cached reads and input without another capture", async change => {
  const f = await fixture(), view = await f.read(["ui"]);
  if (change === "safe") f.setMode("safe");
  else f.setLifetime(change === "closed" ? undefined : "different-native-life");
  const checked = await f.resources.read(view.observation, cwd, ["ui"]);
  expect(checked?.details.status).toBe("refused");
  expect(checked?.content.every(block => block.type === "text")).toBe(true);
  await expect(f.resources.perform(view.observation, cwd, "forbidden", "write")).rejects.toThrow(/expired/i);
  expect(f.inputs()).toHaveLength(0); expect(f.captures()).toHaveLength(1);
});

test.each(["safe", "closed", "reused"] as const)("%s after reading refuses direct input against the bound observation", async change => {
  const f = await fixture(), view = await f.read(["ui"]);
  if (change === "safe") f.setMode("safe");
  else f.setLifetime(change === "closed" ? undefined : "different-native-life");
  expect((await f.resources.perform(view.observation, cwd, JSON.stringify({ action: "click", hint: view.hint }), "insert")).details.status).toBe("refused");
  expect(f.inputs()).toHaveLength(0); expect(f.captures()).toHaveLength(1);
});

test("display resources and their observations never grant Write or Insert authority", async () => {
  const f = await fixture(), display = address("computer:display/primary");
  const result = await f.resources.read(display, cwd);
  expect(result?.details.status).toBe("observed");
  const observed = address(computerSource("observation", result!.details.agent_image!.image_id as string));
  for (const target of [display, observed]) {
    await expect(f.resources.perform(target, cwd, "not input", "write")).rejects.toThrow(/observation|readonly/i);
    await expect(f.resources.perform(target, cwd, JSON.stringify({ action: "click", x: 10, y: 10 }), "insert")).rejects.toThrow(/observation|readonly|only resize/i);
  }
  expect(f.inputs()).toHaveLength(0); expect(f.captures()).toHaveLength(1);
  f.setMode("safe");
  const denied = await f.resources.read(observed, cwd);
  expect(denied?.details.status).toBe("refused");
  expect(denied?.content.every(block => block.type === "text")).toBe(true);
  expect(f.captures()).toHaveLength(1);
});

test("a successful rectangle Read is readonly detail and consumes its overview without a new capture", async () => {
  const f = await fixture(), view = await f.read();
  const detail = await f.resources.read(view.observation, cwd, ["region:80,60,40,20"]);
  expect(detail?.details.status).toBe("observed");
  expect(detail?.content.some(block => block.type === "image" && block.mimeType === "image/jpeg")).toBe(true);
  expect(detail?.details).not.toHaveProperty("observation_id");
  expect(f.captures()).toHaveLength(1);
  expect(f.native().filter(([name]) => name === "zoom")).toEqual([["zoom", { pid: 42, window_id: 91, x1: 80, y1: 60, x2: 120, y2: 80 }, undefined]]);
  await expect(f.resources.perform(view.observation, cwd, JSON.stringify({ action: "click", x: 100, y: 70 }), "insert")).rejects.toThrow(/expired/i);
  expect(f.inputs()).toHaveLength(0);
});

test("invalid JSON and identity overrides are rejected before native input and cannot broaden the bound target", async () => {
  const f = await fixture(), view = await f.read(["ui"]);
  for (const value of ["not JSON", "[]", JSON.stringify({ action: "click", hint: view.hint, window_ref: "other-window" }),
    JSON.stringify({ action: "click", hint: view.hint, observation_id: "other-observation" })])
    await expect(f.resources.perform(view.observation, cwd, value, "insert")).rejects.toThrow();
  const hinted = address(`${view.source}?hint=${encodeURIComponent(view.hint!)}`);
  await expect(f.resources.perform(hinted, cwd, JSON.stringify({ action: "click", x: 100, y: 70 }), "insert")).rejects.toThrow(/target|hint/i);
  expect(f.inputs()).toHaveLength(0); expect(f.captures()).toHaveLength(1);
  expect((await f.resources.perform(hinted, cwd, "valid literal", "write")).details.status).toBe("delivered");
  expect(f.inputs()[0][1]).toMatchObject({ target: { kind: "window", pid: 42, window_id: 91 }, text: "valid literal" });
});

test("pre-dispatch cancellation cannot send input or leave a reusable provider handle", async () => {
  const f = await fixture(), view = await f.read(["ui"]), cancellation = new AbortController();
  cancellation.abort();
  expect((await f.resources.perform(view.observation, cwd, JSON.stringify({ action: "click", hint: view.hint }), "insert", cancellation.signal)).details.status).toBe("refused");
  await expect(f.resources.perform(view.observation, cwd, "retry", "write")).rejects.toThrow(/expired/i);
  expect(f.inputs()).toHaveLength(0); expect(f.captures()).toHaveLength(1);
});

test.each(["native-partial", "in-flight-cancel"] as const)("%s preserves the attempted sequence prefix and never dispatches its successor", async interruption => {
  const f = await fixture(), view = await f.read(["ui"]), cancellation = new AbortController();
  if (interruption === "native-partial") f.setOutcome({ isError: true, content: [], structuredContent: { status: "partial", delivered_prefix: 1 } });
  else f.afterInput(() => cancellation.abort());
  const command = JSON.stringify({ action: "sequence", sequence: [
    { action: "type_text", hint: view.hint, text: "first prefix", delay_ms: 0 },
    { action: "key", key: "return" },
  ] });
  const result = await f.resources.perform(view.observation, cwd, command, "insert", cancellation.signal);
  // A cancelled sequence lets its current step finish and reports it; a native partial step stays unknown.
  expect(result.details.status).toBe(interruption === "native-partial" ? "unknown" : "refused");
  expect(result.details.state).toMatchObject({ sequence: { total: 2, attempted: 1, completed: interruption === "native-partial" ? 0 : 1, steps: [{ action: "type_text" }] } });
  expect(f.inputs()).toHaveLength(1); expect(f.inputs()[0][1]).toMatchObject({ text: "first prefix" });
  const captured = f.captures().length;
  await expect(f.resources.perform(view.observation, cwd, command, "insert")).rejects.toThrow(/expired/i);
  expect(f.inputs()).toHaveLength(1); expect(f.captures()).toHaveLength(captured);
});

test("an address delivery preference does not block semantic actions", async () => {
  const f = await fixture();
  (f.driver as Driver & { semanticActions: boolean }).semanticActions = true;
  const view = await f.read();
  const hinted = address(`${view.source}?hint=${encodeURIComponent(view.hint!)}&delivery=foreground`);
  await f.resources.perform(hinted, cwd, JSON.stringify({ action: "set_value", text: "13" }), "insert");
  expect(f.inputs().map(([name]) => name)).toEqual(["semantic_action"]);
  expect(f.inputs()[0][1]).toMatchObject({ operation: "set_value", value: "13" });
  expect(f.inputs()[0][1]).not.toHaveProperty("delivery_mode");
});

test("a display overview accepts a size for that Read only", async () => {
  const f = await fixture(), display = address("computer:display/primary");
  await f.resources.read(display, cwd, ['capture:{"maxLongEdge":320}']);
  expect(f.captures().at(-1)).toEqual(["get_desktop_state", { max_image_dimension: 320 }, undefined]);
  await f.resources.read(display, cwd);
  expect(f.captures().at(-1)).toEqual(["get_desktop_state", { max_image_dimension: 1280 }, undefined]);
  await expect(f.resources.read(display, cwd, ['capture:{"max_elements":5}'])).rejects.toThrow(/accepts only capture/);
});

test("pixel-only input keeps the observation until the window size changes; UI hints and other input spend it", async () => {
  const f = await fixture();
  (f.driver as Driver & { windowManagement: boolean }).windowManagement = true;
  const view = await f.read();
  const click = (x: number) => f.resources.perform(view.observation, cwd, JSON.stringify({ action: "click", x, y: 40 }), "insert");
  for (const x of [10, 20, 30]) expect((await click(x)).details.status).toBe("delivered");
  expect(f.captures()).toHaveLength(1);
  // The native capture is single-use; kept observations send window-local pixels without it.
  expect(f.inputs()[0][1]).toMatchObject({ capture_id: "capture-1" });
  expect(f.inputs()[1][1]).not.toHaveProperty("capture_id");
  const hinted = await f.resources.perform(view.observation, cwd, JSON.stringify({ action: "click", hint: view.hint }), "insert");
  expect(hinted.details.status).toBe("refused");
  expect(hinted.content[0]).toMatchObject({ text: expect.stringContaining("UI hints of this observation expired") });
  const again = await f.read();
  f.setBounds({ x: 300, y: 90, width: 500, height: 320 });
  expect((await f.resources.perform(again.observation, cwd, JSON.stringify({ action: "click", x: 5, y: 5 }), "insert")).details.status).toBe("delivered");
  f.setBounds({ x: 300, y: 90, width: 640, height: 320 });
  const resized = await f.resources.perform(again.observation, cwd, JSON.stringify({ action: "click", x: 5, y: 5 }), "insert");
  expect(resized.details.status).toBe("refused");
  expect(resized.content[0]).toMatchObject({ text: expect.stringContaining("resized from 500x320 to 640x320") });
  await expect(f.resources.perform(again.observation, cwd, JSON.stringify({ action: "click", x: 5, y: 5 }), "insert")).rejects.toThrow(/expired/i);
});
