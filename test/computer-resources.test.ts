import { expect, test, vi } from "vitest";
import sharp from "sharp";
import { computerSource } from "../src/computer-address.ts";
import { ComputerResources, requireComputerAddress } from "../src/computer-resources.ts";
import { clickPlan, pressPlan, scrollPlan, typePlan } from "../src/computer-tools.ts";
import { ComputerSession, type ComputerMode, type Content, type Driver, type DriverResult } from "../src/session.ts";

const cwd = "/synthetic-computer-fixture";
const address = requireComputerAddress;
const inputNames = new Set(["type_text", "click", "press_key", "hotkey", "scroll", "scroll_at", "drag", "semantic_action"]);

async function fixture() {
  let mode: ComputerMode = "yolo", lifetime: string | undefined = "native-life", serial = 0;
  let outcome: DriverResult | ((name: string, args: Record<string, unknown>) => DriverResult) = { content: [], structuredContent: { effect: "confirmed" } };
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
      if (inputNames.has(name)) { afterInput?.(); return typeof outcome === "function" ? outcome(name, args) : outcome; }
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
    setOutcome(value: typeof outcome) { outcome = value; }, afterInput(value: () => void) { afterInput = value; },
    setBounds(value: typeof liveBounds) { liveBounds = value; } };
}

test("typed text is sent exactly and descriptor/UI reads do not refresh native grounding", async () => {
  const f = await fixture(), view = await f.read(["ui"]);
  const before = f.native().length;
  expect(f.resources.descriptor(view.observation)).toContain(view.source);
  expect((await f.resources.read(view.observation, cwd, ["ui"]))?.details.observation_id).toBe(view.result.details.observation_id);
  expect((await f.resources.search(view.observation, cwd, "Text field"))?.details.status).toBe("observed");
  expect(f.native()).toHaveLength(before);
  const literal = '  {"looks":"like JSON"}\n"quoted text"\n  ';
  const target = { ...view.observation, hint: view.hint! } as typeof view.observation;
  const written = await f.resources.perform(target, cwd, JSON.stringify({ action: "type_text", text: literal, delivery_mode: "foreground", delay_ms: 0 }));
  expect(written.details.status).toBe("delivered");
  // The only captures after input are the successor's UI walks; the unchanged fixture UI reads as no change.
  expect(written.details.successor?.diff?.counts).toEqual({ changed: 0, added: 0, removed: 0 });
  expect(written.details.successor?.diff?.waited_ms).toBeGreaterThanOrEqual(300);
  const captured = f.captures().length;
  expect(f.inputs()).toEqual([["type_text", {
    target: { kind: "window", pid: 42, window_id: 91 }, delivery_mode: "foreground",
    element_token: "snapshot-1:0", text: literal, delay_ms: 0,
  }, undefined]]);
  await expect(f.resources.perform(target, cwd, JSON.stringify({ action: "type_text", text: "replay" }))).rejects.toThrow(/expired/i);
  expect(f.inputs()).toHaveLength(1); expect(f.captures()).toHaveLength(captured);
});

test.each(["refused", "unknown"] as const)("a native %s receipt consumes the provider handle without refreshing or replaying input", async status => {
  const f = await fixture(), view = await f.read(["ui"]);
  f.setOutcome({ isError: true, content: [{ type: "text", text: "Native outcome" }], structuredContent: { status } });
  const command = JSON.stringify({ action: "click", hint: view.hint });
  const result = await f.resources.perform(view.observation, cwd, command);
  expect(result.details.status).toBe(status);
  // A refusal sent nothing, so nothing is re-read; an unknown outcome gets a successor to show what may have happened.
  if (status === "refused") expect(f.captures()).toHaveLength(1);
  else expect(result.details.successor?.observation_id).toBeDefined();
  const captured = f.captures().length;
  await expect(f.resources.perform(view.observation, cwd, command)).rejects.toThrow(/expired/i);
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
  await expect(f.resources.read(f.window, cwd, ['sequence:{"duration_ms":1,"max_frames":1}'])).rejects.toThrow(/computer_record/);
  const captured = await f.resources.sequence(f.window, cwd, ['sequence:{"duration_ms":1,"max_frames":1}']);
  expect(captured?.details.sequence?.frames).toHaveLength(1);
  await expect(f.resources.perform(view.observation, cwd, JSON.stringify({ action: "type_text", text: "stale" }))).rejects.toThrow(/expired/i);
  const sequence = address(computerSource("sequence", captured!.details.sequence!.sequence_id));
  const before = f.captures().length;
  const frames = await f.resources.read(sequence, cwd, ["frames:first"]);
  expect(frames?.content.some(block => block.type === "image")).toBe(true);
  expect(frames?.details.selected_frames?.[0].index).toBe(0);
  await expect(f.resources.perform(sequence, cwd, JSON.stringify({ action: "type_text", text: "not authority" }))).rejects.toThrow(/observation address/i);
  expect(f.captures()).toHaveLength(before);
  expect(f.inputs()).toHaveLength(0);
});

test("a new overview retires the prior resource instead of rebinding its hint", async () => {
  const f = await fixture(), first = await f.read(["ui"]), latest = await f.read(["ui"]);
  expect(latest.source).not.toBe(first.source);
  await expect(f.resources.read(first.observation, cwd, ["ui"])).rejects.toThrow(/expired/i);
  await expect(f.resources.perform(first.observation, cwd, JSON.stringify({ action: "type_text", text: "stale" }))).rejects.toThrow(/expired/i);
  expect(f.inputs()).toHaveLength(0);
  expect((await f.resources.perform({ ...latest.observation, hint: latest.hint! } as typeof latest.observation, cwd, JSON.stringify({ action: "type_text", text: "current" }))).details.status).toBe("delivered");
  expect(f.inputs()[0][1]).toMatchObject({ element_token: "snapshot-2:0", text: "current" });
  // Two overviews, then the input, then the successor's captures.
  const order = f.native().map(([name]) => name).filter(name => name !== "list_windows" && name !== "get_window_control_state");
  expect(order.slice(0, 3)).toEqual(["get_window_state", "get_window_state", f.inputs()[0][0]]);
  expect(order.slice(3).every(name => name === "get_window_state")).toBe(true);
});

test.each(["safe", "closed", "reused"] as const)("%s targets refuse cached reads and input without another capture", async change => {
  const f = await fixture(), view = await f.read(["ui"]);
  if (change === "safe") f.setMode("safe");
  else f.setLifetime(change === "closed" ? undefined : "different-native-life");
  const checked = await f.resources.read(view.observation, cwd, ["ui"]);
  expect(checked?.details.status).toBe("refused");
  expect(checked?.content.every(block => block.type === "text")).toBe(true);
  await expect(f.resources.perform(view.observation, cwd, JSON.stringify({ action: "type_text", text: "forbidden" }))).rejects.toThrow(/expired/i);
  expect(f.inputs()).toHaveLength(0); expect(f.captures()).toHaveLength(1);
});

test.each(["safe", "closed", "reused"] as const)("%s after reading refuses direct input against the bound observation", async change => {
  const f = await fixture(), view = await f.read(["ui"]);
  if (change === "safe") f.setMode("safe");
  else f.setLifetime(change === "closed" ? undefined : "different-native-life");
  expect((await f.resources.perform(view.observation, cwd, JSON.stringify({ action: "click", hint: view.hint }))).details.status).toBe("refused");
  expect(f.inputs()).toHaveLength(0); expect(f.captures()).toHaveLength(1);
});

test("display resources and their observations never take input", async () => {
  const f = await fixture(), display = address("computer:machine/local/display/primary");
  const result = await f.resources.read(display, cwd);
  expect(result?.details.status).toBe("observed");
  const observed = address(computerSource("observation", result!.details.agent_image!.image_id as string));
  for (const target of [display, observed]) {
    await expect(f.resources.perform(target, cwd, JSON.stringify({ action: "type_text", text: "not input" }))).rejects.toThrow(/observation|readonly|only resize/i);
    await expect(f.resources.perform(target, cwd, JSON.stringify({ action: "click", x: 10, y: 10 }))).rejects.toThrow(/observation|readonly|only resize/i);
  }
  expect(f.inputs()).toHaveLength(0); expect(f.captures()).toHaveLength(1);
  f.setMode("safe");
  const denied = await f.resources.read(observed, cwd);
  expect(denied?.details.status).toBe("refused");
  expect(denied?.content.every(block => block.type === "text")).toBe(true);
  expect(f.captures()).toHaveLength(1);
});

// LPT-931: a rectangle of a window is a viewport; the region view of a window observation refuses and keeps it current.
test("a region Read of a window observation refuses before anything is sent and points to computer_view", async () => {
  const f = await fixture(), view = await f.read();
  await expect(f.resources.read(view.observation, cwd, ["region:80,60,40,20"])).rejects.toThrow(/computer_view/);
  await expect(f.resources.read(f.window, cwd, ["region:80,60,40,20"])).rejects.toThrow(/computer_view/);
  expect(f.native().filter(([name]) => name === "zoom")).toHaveLength(0);
  expect(f.captures()).toHaveLength(1);
  // The observation is still current for input.
  expect((await f.resources.perform(view.observation, cwd, JSON.stringify({ action: "click", x: 100, y: 70 }))).details.status).toBe("delivered");
});

test("an element crop is readonly detail and consumes its overview without a new capture", async () => {
  const f = await fixture(), view = await f.read();
  const detail = await f.resources.read(view.observation, cwd, [`element:crop,${view.hint}`]);
  expect(detail?.details.status).toBe("observed");
  expect(detail?.content.some(block => block.type === "image" && block.mimeType === "image/jpeg")).toBe(true);
  expect(detail?.details).not.toHaveProperty("observation_id");
  expect(f.captures()).toHaveLength(1);
  expect(f.native().filter(([name]) => name === "zoom")).toEqual([["zoom", { pid: 42, window_id: 91, x1: 80, y1: 60, x2: 120, y2: 80 }, undefined]]);
  await expect(f.resources.perform(view.observation, cwd, JSON.stringify({ action: "click", x: 100, y: 70 }))).rejects.toThrow(/expired/i);
  expect(f.inputs()).toHaveLength(0);
});

// LPT-941: an element crop spends the window's current observation; point input then captures the window again.
test("a point click after an element crop captures the window again, while a ref of the spent Read still refuses", async () => {
  const f = await fixture(), view = await f.read();
  await f.resources.read(view.observation, cwd, [`element:crop,${view.hint}`]);
  const calls = f.native().length;
  const clicked = await f.resources.input(f.window, cwd, clickPlan({ window: f.window.source, x: 100, y: 70 }));
  expect(clicked.details.status, JSON.stringify(clicked.content)).toBe("delivered");
  // The click captured the window first; it did not act on the spent observation.
  expect(f.native().slice(calls).map(([name]) => name).filter(name => name !== "list_windows").slice(0, 2)).toEqual(["get_window_state", "click"]);
  const full = await f.read();
  await f.resources.read(full.observation, cwd, [`element:crop,${full.hint}`]);
  const inputs = f.inputs().length;
  await expect(f.resources.input(f.window, cwd, clickPlan({ window: f.window.source, target: full.hint! }))).rejects.toThrow(/is not a ref of this window's latest Read/);
  expect(f.inputs()).toHaveLength(inputs);
});

test("a point click after a window sequence captures the window again", async () => {
  const f = await fixture();
  await f.read(["image"]);
  const recorded = await f.resources.sequence(f.window, cwd, ['sequence:{"duration_ms":100,"fps":10,"max_frames":1}']);
  expect(recorded?.details.status).toBe("observed");
  const calls = f.native().length;
  const clicked = await f.resources.input(f.window, cwd, clickPlan({ window: f.window.source, x: 100, y: 70 }));
  expect(clicked.details.status, JSON.stringify(clicked.content)).toBe("delivered");
  expect(f.native().slice(calls).map(([name]) => name).filter(name => name !== "list_windows").slice(0, 2)).toEqual(["get_window_state", "click"]);
});

test("invalid JSON and identity overrides are rejected before native input and cannot broaden the bound target", async () => {
  const f = await fixture(), view = await f.read(["ui"]);
  for (const value of ["not JSON", "[]", JSON.stringify({ action: "click", hint: view.hint, window_ref: "other-window" }),
    JSON.stringify({ action: "click", hint: view.hint, observation_id: "other-observation" })])
    await expect(f.resources.perform(view.observation, cwd, value)).rejects.toThrow();
  const hinted = { ...view.observation, hint: view.hint! } as typeof view.observation;
  await expect(f.resources.perform(hinted, cwd, JSON.stringify({ action: "click", x: 100, y: 70 }))).rejects.toThrow(/target|hint/i);
  expect(f.inputs()).toHaveLength(0); expect(f.captures()).toHaveLength(1);
  expect((await f.resources.perform(hinted, cwd, JSON.stringify({ action: "type_text", text: "valid literal" }))).details.status).toBe("delivered");
  expect(f.inputs()[0][1]).toMatchObject({ target: { kind: "window", pid: 42, window_id: 91 }, text: "valid literal" });
});

test("pre-dispatch cancellation cannot send input or leave a reusable provider handle", async () => {
  const f = await fixture(), view = await f.read(["ui"]), cancellation = new AbortController();
  cancellation.abort();
  expect((await f.resources.perform(view.observation, cwd, JSON.stringify({ action: "click", hint: view.hint }), cancellation.signal)).details.status).toBe("refused");
  await expect(f.resources.perform(view.observation, cwd, JSON.stringify({ action: "type_text", text: "retry" }))).rejects.toThrow(/expired/i);
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
  const result = await f.resources.perform(view.observation, cwd, command, cancellation.signal);
  // A cancelled sequence lets its current step finish and reports it; a native partial step stays unknown.
  expect(result.details.status).toBe(interruption === "native-partial" ? "unknown" : "refused");
  expect(result.details.state).toMatchObject({ sequence: { total: 2, attempted: 1, completed: interruption === "native-partial" ? 0 : 1, steps: [{ action: "type_text" }] } });
  expect(f.inputs()).toHaveLength(1); expect(f.inputs()[0][1]).toMatchObject({ text: "first prefix" });
  const captured = f.captures().length;
  await expect(f.resources.perform(view.observation, cwd, command)).rejects.toThrow(/expired/i);
  expect(f.inputs()).toHaveLength(1); expect(f.captures()).toHaveLength(captured);
});

test("computer_type replace on a ref sets the value through UI Automation, without a delivery mode", async () => {
  const f = await fixture();
  (f.driver as Driver & { semanticActions: boolean }).semanticActions = true;
  const view = await f.read();
  await f.resources.input(f.window, cwd, typePlan({ window: f.window.source, target: view.hint!, text: "13", replace: true }));
  expect(f.inputs().map(([name]) => name)).toEqual(["semantic_action"]);
  expect(f.inputs()[0][1]).toMatchObject({ operation: "set_value", value: "13" });
  expect(f.inputs()[0][1]).not.toHaveProperty("delivery_mode");
});

// LPT-942: what the agent sees structurally is pressed structurally; points and keys are real input.
test("a click on a ref goes through UI Automation only, and no pattern means the real pointer", async () => {
  const f = await fixture();
  let view = await f.read();
  const structural = await f.resources.input(f.window, cwd, clickPlan({ window: f.window.source, target: view.hint! }));
  expect(structural.details.status).toBe("delivered");
  expect(f.inputs()).toEqual([["click", { target: { kind: "window", pid: 42, window_id: 91 }, delivery_mode: "background", element_token: expect.any(String), uia_only: true }, undefined]]);
  // The driver finds no pattern: it refuses before sending anything, and the click goes again with the real pointer.
  f.setOutcome((_name, args) => args.uia_only ? { isError: true, content: [{ type: "text", text: "no UIA pattern" }],
    structuredContent: { code: "background_unavailable", effect: "refused", escalation: { recommended: "foreground" } } } : { content: [], structuredContent: { effect: "confirmed" } });
  view = await f.read();
  const real = await f.resources.input(f.window, cwd, clickPlan({ window: f.window.source, target: view.hint! }));
  expect(real.details.status).toBe("delivered");
  expect(real.content[0]).toEqual({ type: "text", text: "No UI Automation pattern of the target carried this click, so this call used the real pointer." });
  const [refused, sent] = f.inputs().slice(1);
  expect(refused[1]).toMatchObject({ uia_only: true, delivery_mode: "background" });
  expect(sent[0]).toBe("click");
  expect(sent[1]).toMatchObject({ delivery_mode: "foreground" });
  expect(sent[1]).not.toHaveProperty("uia_only");
});

// LPT-948: a triple click selects a field's value; no UI Automation pattern carries a multi-click, so it is real input.
test("triple clicks and right or middle double clicks reach a native window as real clicks", async () => {
  const f = await fixture();
  let view = await f.read();
  const triple = await f.resources.input(f.window, cwd, clickPlan({ window: f.window.source, target: view.hint!, count: 3 }));
  expect(triple.details.status).toBe("delivered");
  view = await f.read();
  await f.resources.input(f.window, cwd, clickPlan({ window: f.window.source, x: 100, y: 70, button: "right", count: 2 }));
  await f.resources.input(f.window, cwd, clickPlan({ window: f.window.source, x: 100, y: 70, button: "middle", count: 2 }));
  expect(f.inputs()).toEqual([
    ["click", { target: { kind: "window", pid: 42, window_id: 91 }, delivery_mode: "foreground", element_token: expect.any(String), count: 3 }, undefined],
    ["click", expect.objectContaining({ delivery_mode: "foreground", x: expect.any(Number), y: expect.any(Number), button: "right", count: 2 }), undefined],
    ["click", expect.objectContaining({ delivery_mode: "foreground", button: "middle", count: 2 }), undefined]]);
  expect(f.inputs().some(([, args]) => "uia_only" in (args as object))).toBe(false);
});

test("points and keys are real input; nothing posts window messages", async () => {
  const f = await fixture();
  (f.driver as Driver & { coordinateScroll: boolean }).coordinateScroll = true;
  await f.read();
  await f.resources.input(f.window, cwd, clickPlan({ window: f.window.source, x: 100, y: 70 }));
  await f.resources.input(f.window, cwd, pressPlan({ window: f.window.source, key: "ctrl+s" }));
  await f.resources.input(f.window, cwd, typePlan({ window: f.window.source, text: "hi" }));
  await f.resources.input(f.window, cwd, scrollPlan({ window: f.window.source, delta_y: 2 }));
  expect(f.inputs().map(([name, args]) => [name, (args as { delivery_mode?: string }).delivery_mode, "uia_only" in (args as object)])).toEqual([
    ["click", "foreground", false], ["hotkey", "foreground", false], ["type_text", "foreground", false], ["scroll_at", "foreground", false]]);
});

test("a display overview accepts a size for that Read only", async () => {
  const f = await fixture(), display = address("computer:machine/local/display/primary");
  await f.resources.read(display, cwd, ['capture:{"maxLongEdge":320}']);
  expect(f.captures().at(-1)).toEqual(["get_desktop_state", { max_image_dimension: 320 }, undefined]);
  await f.resources.read(display, cwd);
  expect(f.captures().at(-1)).toEqual(["get_desktop_state", { max_image_dimension: 1280 }, undefined]);
  await expect(f.resources.read(display, cwd, ['capture:{"max_elements":5}'])).rejects.toThrow(/accepts only capture/);
});

