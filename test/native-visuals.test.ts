import { expect, test, vi } from "vitest";
import { NativeVisuals, VisualSettings, nativeVisualOptions, notifyHighlight } from "../src/native-visuals.ts";
import sharp from "sharp";
import { ComputerSession, type Driver, type DriverResult } from "../src/session.ts";
import type { InputCommand } from "../src/complete-input.ts";
import { WebError, type WebAction, type WebBrowser, type WebLauncher } from "../src/web-browser.ts";

const frame = { target: { window_id: 101, pid: 42 }, identity: `PiComputerUse.${"a".repeat(32)}:42:1`,
  bounds: { x: -100, y: 20, width: 800, height: 600 } };
const tick = async () => { for (let n = 0; n < 8; n++) await Promise.resolve(); };

test("presentation returns immediately while native admission is pending, with only the newest pending image retained", async () => {
  const sent: { name: string; args: Record<string, unknown> }[] = [];
  let release!: () => void;
  const visuals = new NativeVisuals(async (name, args) => { sent.push({ name, args }); await new Promise<void>(r => { release = r; }); return true; });
  expect(await visuals.flash(frame)).toMatchObject({ status: "queued" });
  await tick();
  for (let n = 1; n <= 100; n++) await visuals.flash({ ...frame, mark: { kind: "action", point: { x: n, y: 50 } } });
  expect(sent).toHaveLength(1);
  release(); await tick();
  expect(sent).toHaveLength(2);
  expect(sent[1].args).toMatchObject({ generation: 101, point: { x: 100, y: 50 } });
  release(); await tick(); visuals.close();
});

test("previews contain the supplied output image and validated physical source, never a new capture", async () => {
  const send = vi.fn(async (_name: string, _args: Record<string, unknown>) => true); const visuals = new NativeVisuals(send);
  const image = { type: "image" as const, mimeType: "image/png", data: "aGVsbG8=" };
  await notifyHighlight(visuals.flash, { ...frame, image }); await tick();
  expect(send).toHaveBeenCalledExactlyOnceWith("present_agent_activity", {
    generation: 1, kind: "overview", source: { window_id: 101, pid: 42, identity: frame.identity, bounds: frame.bounds },
    image: { data: image.data, mime_type: image.mimeType },
  });
  visuals.close();
});

test("invalid or out-of-source geometry is cleared without sending image content", async () => {
  const send = vi.fn(async (_name: string, _args: Record<string, unknown>) => true); const visuals = new NativeVisuals(send);
  const result = await notifyHighlight(visuals.flash, { ...frame, identity: frame.identity.replace(":42:", ":99:") });
  await tick();
  expect(result?.status).toBe("unavailable");
  expect(send.mock.calls).toEqual([["present_agent_activity", { kind: "clear", generation: 1 }]]);
  visuals.close();
});

test("off discards queued images and old cancellation cannot clear a newer event", async () => {
  const send = vi.fn(async (_name: string, _args: Record<string, unknown>) => true); const settings = new VisualSettings(); const visuals = new NativeVisuals(send, settings);
  const abort = new AbortController();
  await visuals.flash(frame, abort.signal); await tick();
  await visuals.flash(frame); await tick();
  abort.abort(); await tick();
  expect(send).toHaveBeenCalledTimes(2);
  settings.update({ preset: "off" }); await tick();
  expect(send.mock.calls.at(-1)).toEqual(["set_agent_visuals", expect.objectContaining({ preset: "off" })]);
  const count = send.mock.calls.length;
  expect(await visuals.flash(frame)).toMatchObject({ status: "skipped" });
  await tick(); expect(send).toHaveBeenCalledTimes(count); visuals.close();
});

test("selected-display regions retain their physical monitor origin", async () => {
  const send = vi.fn(async (_name: string, _args: Record<string, unknown>) => true); const visuals = new NativeVisuals(send);
  await visuals.flash({ display: "DISPLAY2", bounds: { x: -1920, y: 0, width: 1920, height: 1080 }, mark: {
    kind: "detail", region: { x: -1900, y: 40, width: 200, height: 100 },
  } }); await tick();
  expect(send.mock.calls[0][1]).toMatchObject({ source: { display: "DISPLAY2", bounds: { x: -1920, y: 0 } }, region: { x: -1900, y: 40 } });
  visuals.close();
});

test("restoring a branch resets unrelated preferences and rejects prototype keys", () => {
  const settings = new VisualSettings();
  settings.update({ keyboard: false, quality: "high" });
  expect(settings.restore({ preset: "subtle" })).toMatchObject({ keyboard: true, quality: "balanced", previews: false });
  const before = settings.current();
  expect(() => settings.update(JSON.parse('{"constructor":false}'))).toThrow();
  expect(settings.current()).toEqual(before);
});
test("settings validate before mutation and unavailable native presentation does not throw into operations", async () => {
  const settings = new VisualSettings();
  expect(() => settings.update({ opacity: NaN })).toThrow();
  expect(settings.current().opacity).toBe(0.8);
  const visuals = new NativeVisuals(async () => { throw new Error("not available"); }, settings);
  expect(await visuals.flash(frame)).toMatchObject({ status: "queued" }); await tick();
  expect(await visuals.flash(frame)).toMatchObject({ status: "unavailable" }); visuals.close();
});


async function actionFixture(outcome: "delivered" | "refused" | "unknown" = "delivered", options: { password?: boolean; settings?: VisualSettings } = {}) {
  const png = { type: "image" as const, mimeType: "image/png", data: (await sharp({ create: {
    width: frame.bounds.width, height: frame.bounds.height, channels: 3, background: "white",
  } }).png().toBuffer()).toString("base64") };
  const send = vi.fn(async (_name: string, _args: Record<string, unknown>) => true);
  const visuals = new NativeVisuals(send, options.settings);
  const driver: Driver = {
    visuals: visuals.flash, heldKeys: true, heldPaths: true, captureBoundDrag: true, semanticActions: true,
    identity: vi.fn(async () => frame.identity), close: vi.fn(async () => {}),
    call: vi.fn<Driver["call"]>(async (name, args): Promise<DriverResult> => {
      if (name === "list_windows") return { content: [], structuredContent: { windows: [{
        ...frame.target, bounds: frame.bounds, app_name: "Fixture.exe", title: "Action fixture - Google Chrome",
      }] } };
      if (name === "get_window_state") return { content: [png], structuredContent: {
        ...frame.target, window_bounds: frame.bounds, capture_id: "11111111-1111-4111-8111-111111111111",
        screenshot_width: frame.bounds.width, screenshot_height: frame.bounds.height,
        elements: [{ element_token: "field", role: "TextBox", focused: true, frame: { x: 0, y: 60, w: 80, h: 40 }, ...(options.password ? { password: true } : {}) }],
      } };
      if (outcome !== "delivered") return { content: [], structuredContent: { effect: outcome } };
      return { content: [], structuredContent: name === "semantic_action"
        ? { operation: args.operation, pattern: "value", route: "accessibility", effect: "unverifiable", fallback: false, delivery: { mode: "background" } }
        : { effect: "unverifiable" } };
    }),
  };
  const browser = { close: vi.fn(async () => {}), page: vi.fn(async () => ({
    url: "https://fixture.invalid", title: "Action fixture", snapshot: '- textbox "Field"', tabs: [], events: [],
  })) };
  const launch: WebLauncher = async () => ({ browser: browser as unknown as WebBrowser,
    opened: { pid: frame.target.pid, version: "155", url: "https://fixture.invalid", title: "Action fixture", via: "cdp" } });
  const session = new ComputerSession(driver, () => "yolo", undefined, undefined, launch);
  return { session, driver, send, browser, close: async () => { visuals.close(); await session.close(); } };
}

const nativeFamilies: { label: string; command: InputCommand; family: string; native: string }[] = [
  { label: "typing", command: { action: "type_text", text: "synthetic-private-text" }, family: "type_text", native: "type_text" },
  { label: "key press", command: { action: "key", key: "f12" }, family: "press_key", native: "press_key" },
  { label: "select all", command: { action: "select_all" }, family: "hotkey", native: "hotkey" },
  { label: "semantic value", command: { action: "set_value", element_token: "field", text: "synthetic-private-value" }, family: "fill", native: "semantic_action" },
  { label: "scroll", command: { action: "scroll", element_token: "field", direction: "down" }, family: "scroll", native: "scroll" },
  { label: "drag", command: { action: "drag", from_x: 10, from_y: 10, to_x: 100, to_y: 100, duration_ms: 10 }, family: "drag", native: "drag" },
  { label: "keyboard hold", command: { action: "hold", keys: ["ctrl"], duration_ms: 10 }, family: "hotkey", native: "hold_keys" },
  { label: "held pointer", command: { action: "hold", keys: ["ctrl"], duration_ms: 10,
    actions: [{ action: "drag", from_x: 10, from_y: 10, to_x: 100, to_y: 100, duration_ms: 10 }] }, family: "input_timeline", native: "hold_keys" },
  { label: "keyboard timeline", command: { action: "timeline", events: [
    { at_ms: 0, type: "key_down", key: "ctrl" }, { at_ms: 10, type: "key_up", key: "ctrl" },
  ] }, family: "hotkey", native: "input_timeline" },
  { label: "pointer timeline", command: { action: "timeline", events: [
    { at_ms: 0, type: "move", x: 10, y: 10 }, { at_ms: 10, type: "wheel", dy: 1 },
  ] }, family: "input_timeline", native: "input_timeline" },
];

test("keyboard previews include the requested shortcut", async () => {
  const f = await actionFixture();
  try {
    const listed = await f.session.windows();
    const ref = (listed.details.state!.windows as { window_ref: string }[])[0].window_ref;
    const read = await f.session.observe(ref); await tick(); f.send.mockClear();
    await f.session.act({ window_ref: ref, observation_id: read.details.observation_id!, action: "hotkey", keys: ["ctrl", "shift", "f12"] });
    await tick();
    const activities = f.send.mock.calls.filter(([name]) => name === "present_agent_activity").map(([, args]) => args);
    expect(activities).toHaveLength(2);
    for (const args of activities) {
      expect(String(args.typed_text).toLowerCase()).toContain("ctrl");
      expect(String(args.typed_text).toLowerCase()).toContain("shift");
      expect(String(args.typed_text).toLowerCase()).toContain("f12");
    }
  } finally { await f.close(); }
});
test.each([
  { options: { password: true } },
  { options: { settings: (() => { const s = new VisualSettings(); s.update({ typed_text: false }); return s; })() } },
])("printable keys are hidden in a protected field or when typed text is disabled", async ({ options }) => {
  const f = await actionFixture("delivered", options);
  try {
    const listed = await f.session.windows();
    const ref = (listed.details.state!.windows as { window_ref: string }[])[0].window_ref;
    const read = await f.session.observe(ref); await tick(); f.send.mockClear();
    await f.session.act({ window_ref: ref, observation_id: read.details.observation_id!, action: "key", key: "a" });
    await tick();
    const activities = f.send.mock.calls.filter(([name]) => name === "present_agent_activity");
    expect(activities).toHaveLength(2);
    for (const [, args] of activities) expect(args).not.toHaveProperty("typed_text");
  } finally { await f.close(); }
});
test("timeline previews include non-text keys and pointer event types", async () => {
  const f = await actionFixture();
  try {
    const listed = await f.session.windows();
    const ref = (listed.details.state!.windows as { window_ref: string }[])[0].window_ref;
    const read = await f.session.observe(ref); await tick(); f.send.mockClear();
    await f.session.act({ window_ref: ref, observation_id: read.details.observation_id!, action: "timeline", events: [
      { at_ms: 0, type: "key_down", key: "f12" }, { at_ms: 1, type: "key_up", key: "f12" },
      { at_ms: 2, type: "wheel", dy: 1 },
    ] });
    await tick();
    const activities = f.send.mock.calls.filter(([name]) => name === "present_agent_activity");
    expect(activities).toHaveLength(2);
    for (const [, args] of activities) {
      expect(String(args.typed_text)).toContain("f12");
      expect(String(args.typed_text)).toContain("wheel");
    }
  } finally { await f.close(); }
});
test.each(nativeFamilies)("native $label retains its presentation family before and after one dispatch", async ({ command, family, native }) => {
  const f = await actionFixture();
  try {
    const listed = await f.session.windows();
    const ref = (listed.details.state!.windows as { window_ref: string }[])[0].window_ref;
    const read = await f.session.observe(ref); await tick(); f.send.mockClear(); vi.mocked(f.driver.call).mockClear();
    const result = await f.session.act({ window_ref: ref, observation_id: read.details.observation_id!, ...command });
    await tick();
    expect(result.details.status).toBe("delivered");
    expect(vi.mocked(f.driver.call).mock.calls.map(([name]) => name)).toEqual([native]);
    const activities = f.send.mock.calls.filter(([name]) => name === "present_agent_activity").map(([, args]) => args);
    expect(activities.map(args => ({ kind: args.kind, action: args.action, outcome: args.outcome }))).toEqual([
      { kind: "action", action: family, outcome: undefined }, { kind: "action", action: family, outcome: "delivered" },
    ]);
    for (const args of activities) {
      expect(args.source).toEqual({ ...frame.target, identity: frame.identity, bounds: frame.bounds });
      expect(Object.keys(args).every(key => ["generation", "kind", "source", "region", "action", "outcome", "typed_text"].includes(key))).toBe(true);
      if (!command.element_token) expect(args).not.toHaveProperty("region");
      // The human sees what the agent types, before and after the dispatch.
      if ("text" in command) expect(args.typed_text).toBe(command.text);
    }
  } finally { await f.close(); }
});

test.each([
  { label: "a password field", options: { password: true } },
  { label: "typed text turned off", options: { settings: (() => { const settings = new VisualSettings(); settings.update({ typed_text: false }); return settings; })() } },
])("typed text is not shown for $label", async ({ options }) => {
  const f = await actionFixture("delivered", options);
  try {
    const listed = await f.session.windows();
    const ref = (listed.details.state!.windows as { window_ref: string }[])[0].window_ref;
    const read = await f.session.observe(ref); await tick(); f.send.mockClear();
    const result = await f.session.act({ window_ref: ref, observation_id: read.details.observation_id!, action: "set_value", element_token: "field", text: "secret" });
    await tick();
    expect(result.details.status).toBe("delivered");
    const activities = f.send.mock.calls.filter(([name]) => name === "present_agent_activity").map(([, args]) => args);
    expect(activities).toHaveLength(2);
    for (const args of activities) expect(args).not.toHaveProperty("typed_text");
  } finally { await f.close(); }
});

test("the native renderer gets its own settings without the typed text toggle", () => {
  const options = new VisualSettings().current();
  expect(options.typed_text).toBe(true);
  expect(nativeVisualOptions(options)).toEqual(Object.fromEntries(Object.entries(options).filter(([key]) => key !== "typed_text")));
});

test.each(["refused", "unknown"] as const)("native keyboard %s keeps its family without replaying input", async outcome => {
  const f = await actionFixture(outcome);
  try {
    const listed = await f.session.windows();
    const ref = (listed.details.state!.windows as { window_ref: string }[])[0].window_ref;
    const read = await f.session.observe(ref); await tick(); f.send.mockClear(); vi.mocked(f.driver.call).mockClear();
    const result = await f.session.act({ window_ref: ref, observation_id: read.details.observation_id!, action: "key", key: "f12" });
    await tick();
    expect(result.details.status).toBe(outcome);
    expect(vi.mocked(f.driver.call).mock.calls.map(([name]) => name)).toEqual(["press_key"]);
    expect(f.send.mock.calls.map(([, args]) => ({ action: args.action, outcome: args.outcome }))).toEqual([
      { action: "press_key", outcome: undefined }, { action: "press_key", outcome },
    ]);
  } finally { await f.close(); }
});

test.each(["a", "Shift+a", "Control+Alt+a"]) ("browser printable key %s is not exposed when focus is unknown", async key => {
  const f = await actionFixture();
  try {
    const opened = await f.session.openBrowser(); const ref = opened.details.window_ref!;
    await f.session.observeDom(ref); await tick(); f.send.mockClear();
    await f.session.actPage(ref, { action: "press", key }); await tick();
    const activities = f.send.mock.calls.filter(([name]) => name === "present_agent_activity");
    expect(activities).toHaveLength(1);
    expect(activities[0][1]).not.toHaveProperty("typed_text");
  } finally { await f.close(); }
});
test.each(["dom", "page"] as const)("browser %s key outcomes include the shortcut without forwarding the target", async route => {
  for (const outcome of ["delivered", "refused", "unknown"] as const) {
    const f = await actionFixture();
    try {
      const opened = await f.session.openBrowser(); const ref = opened.details.window_ref!;
      const read = await f.session.observeDom(ref); await tick(); f.send.mockClear(); f.browser.page.mockClear();
      if (outcome !== "delivered") f.browser.page.mockRejectedValueOnce(new WebError("Synthetic page failure", outcome === "unknown"));
      const action: WebAction = { action: "press", target: { ref: "e1" }, key: "Control+Shift+F12" };
      const result = route === "dom"
        ? await f.session.actDom(ref, read.details.observation_id!, action)
        : await f.session.actPage(ref, action);
      await tick();
      expect(result.details.status).toBe(outcome);
      expect(f.browser.page).toHaveBeenCalledExactlyOnceWith("act", action, undefined);
      expect(f.send.mock.calls).toEqual([["present_agent_activity", {
        generation: expect.any(Number), kind: "action", source: { ...frame.target, identity: frame.identity, bounds: frame.bounds },
        action: "press_key", outcome, typed_text: action.key,
      }]]);
    } finally { await f.close(); }
  }
});
