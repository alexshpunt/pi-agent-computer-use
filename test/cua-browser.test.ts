import { expect, test, vi } from "vitest";
import type { WindowObserver } from "../src/window-overlay.ts";
import { CuaBrowser } from "../src/cua-browser.ts";
import type { Driver, DriverResult } from "../src/session.ts";

const png = { type: "image" as const, mimeType: "image/png", data: "native-png-unchanged" };
const jpeg = { type: "image" as const, mimeType: "image/jpeg", data: "native-jpeg-unchanged" };
function fixture(observer?: WindowObserver) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  let snapshot = 0;
  let alive = true;
  let override: ((name: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<DriverResult | undefined>) | undefined;
  const driver: Driver = {
    async call(name, args, signal) {
      calls.push({ name, args });
      const custom = await override?.(name, args, signal);
      if (custom) return custom;
      let state: Record<string, unknown> = {};
      let content: DriverResult["content"] = [];
      if (name === "start_session") state = { active: true };
      if (name === "bring_to_front") state = { landed_on_target: true, target_hwnd: "0x16", now_fg_hwnd: "0x16", previous_fg_hwnd: "0x99", raised: true, restored: false };
      if (name === "browser_prepare") state = { prepared: true, prepared_pid: 111, action: "launched_isolated_browser" };
      if (name === "list_windows") state = { windows: [{ pid: 111, window_id: 22, bounds: { x: 70, y: 60, width: 1332, height: 932 } }] };
      if (name === "get_browser_state" && args.pid) state = { binding_quality: "exact", mutation_allowed: true, target_id: "owned-target", tabs: [{ tab_id: "owned-tab", active: true, title: "Fixture", url: "http://localhost/" }] };
      if (name === "get_browser_state" && args.target_id) {
        snapshot++;
        state = { snapshot: { id: `p${snapshot}` }, outline: "Selections: fixture", page: { title: "Fixture", url: "http://localhost/" },
          refs: ["One", "Two", "Three", "Four", "Message"].map((name, index) => ({ ref: `p${snapshot}:${index}`, name, role: index === 4 ? "textbox" : "button", actions: index === 4 ? ["type"] : ["click", "pointer"] })) };
      }
      if (name === "get_window_state") { state = { capture_id: "owned-capture", screenshot_width: 500, screenshot_height: 350, window_bounds: { x: 70, y: 60, width: 1332, height: 932 } }; content = [png]; }
      if (name === "zoom") { state = { width: 152, height: 120, mime_type: "image/jpeg" }; content = [jpeg]; }
      if (["browser_click", "browser_type", "browser_pointer", "click"].includes(name)) state = { effect: "unverifiable", route: name === "click" ? "synthetic_events" : "trusted_input", delivery: { mode: "background" } };
      if (name === "end_session") state = { active: false };
      return { content, structuredContent: state };
    },
    async identity() { return alive ? `PiComputerUse.${"a".repeat(32)}:111:1` : undefined; },
    async close() { calls.push({ name: "transport_close", args: {} }); },
  };
  const browser = new CuaBrowser(async () => driver, undefined, observer);
  return { browser, calls, setAlive: (value: boolean) => { alive = value; }, setOverride: (value: typeof override) => { override = value; } };
}

test("only successful returned browser images flash the exact whole source window, including zoom", async () => {
  const observer = vi.fn<WindowObserver>(async () => ({ status: "shown", duration_ms: 2000 }));
  const f = fixture(observer);
  const opened = await f.browser.call("open", { url: "http://localhost/" });
  expect(opened.details).toMatchObject({ status: "observed", highlight: { status: "shown" } });
  expect(observer).toHaveBeenCalledWith({ target: { pid: 111, window_id: 22 }, identity: `PiComputerUse.${"a".repeat(32)}:111:1`,
    bounds: { x: 70, y: 60, width: 1332, height: 932 } }, undefined);
  const hints = (opened.details.elements as { hint: string }[]).map(e => e.hint);
  await f.browser.call("act", { click: hints[0], observe: false });
  expect(observer).toHaveBeenCalledTimes(1);
  await f.browser.call("observe", { image_only: true });
  const detail = await f.browser.call("observe", { zoom: { x: 20, y: 40, width: 50, height: 30 } });
  expect(detail.content).toContainEqual(jpeg);
  expect(observer).toHaveBeenCalledTimes(3);
  expect(observer.mock.calls[2][0]).toHaveProperty("bounds");
  expect((observer.mock.calls[2][0] as { bounds: unknown }).bounds).toEqual({ x: 70, y: 60, width: 1332, height: 932 });
  await f.browser.call("observe", { zoom: { x: 1, y: 1, width: 10, height: 10 } });
  expect(observer).toHaveBeenCalledTimes(3);
  f.setAlive(false);
  await f.browser.call("observe", {});
  expect(observer).toHaveBeenCalledTimes(3);
});

test("a broken rendering observer cannot replay or corrupt a valid native browser capture", async () => {
  const observer = vi.fn<WindowObserver>(async () => { throw new Error("helper unavailable"); });
  const f = fixture(observer); const result = await f.browser.call("open", { url: "http://localhost/" });
  expect(result.details).toMatchObject({ status: "observed", highlight: { status: "unavailable" } });
  expect(result.content).toContainEqual(png);
  expect(f.calls.filter(c => c.name === "get_window_state")).toHaveLength(1);
  expect(f.calls.some(c => c.name === "end_session")).toBe(false);
});

test("CUA owns the isolated browser, cursor, exact target and unchanged native 500px image", async () => {
  const f = fixture(); const result = await f.browser.call("open", { url: "http://localhost/" });
  expect(result.details.status).toBe("observed"); expect(result.content).toContainEqual(png);
  expect(result.details.source).toMatchObject({ kind: "browser", domain: "windows-host",
    identity: { pid: 111, window_id: 22, tab_id: "owned-tab" }, semantic_scope: "owned_page",
    image: { scope: "native_window", dimensions: { width: 500, height: 350 }, original_dimensions: null },
    capabilities: { input: "owned_browser", detail: "browser_window_zoom" } });
  expect(f.calls.find(c => c.name === "browser_prepare")?.args).toMatchObject({ allow_launch: true, profile: { mode: "isolated_new" } });
  expect(f.calls.find(c => c.name === "set_agent_cursor_enabled")?.args.enabled).toBe(true);
  expect(f.calls.find(c => c.name === "get_window_state")?.args).toMatchObject({ pid: 111, window_id: 22, max_image_dimension: 500, include_accessibility_tree: false });
  const session = f.calls[0].args.session; expect(typeof session).toBe("string");
  expect(f.calls.every(c => c.args.session === session)).toBe(true);
  await f.browser.call("close", {});
  expect(f.calls.at(-2)?.name).toBe("end_session"); expect(f.calls.at(-1)?.name).toBe("transport_close");
});

test("four short hints reuse one CUA snapshot, and the next snapshot retires every old alias", async () => {
  const f = fixture(); const first = await f.browser.call("open", { url: "http://localhost/" });
  const hints = (first.details.elements as { hint: string }[]).slice(0, 4).map(e => e.hint);
  for (const hint of hints) expect((await f.browser.call("act", { click: hint, observe: false })).details.status).toBe("acted");
  expect(f.calls.filter(c => c.name === "get_browser_state" && c.args.target_id)).toHaveLength(1);
  const second = await f.browser.call("observe", {});
  const next = (second.details.elements as { hint: string }[]).map(e => e.hint);
  expect(next.some(h => hints.includes(h))).toBe(false);
  const dispatched = f.calls.length;
  expect((await f.browser.call("act", { click: hints[0], observe: false })).details.status).toBe("refused");
  expect(f.calls).toHaveLength(dispatched);
  expect(f.calls.filter(c => c.name === "browser_click").map(c => c.args.ref)).toEqual(["p1:0", "p1:1", "p1:2", "p1:3"]);
});

test("overview and native fresh zoom clicks delegate mapping once, without browser CSS conversion", async () => {
  const f = fixture(); await f.browser.call("open", { url: "http://localhost/" });
  await f.browser.call("act", { click: { x: 44, y: 181 }, observe: false });
  expect(f.calls.find(c => c.name === "click")?.args).toMatchObject({ pid: 111, window_id: 22, x: 44, y: 181, capture_id: "owned-capture", delivery_mode: "background" });
  expect((await f.browser.call("act", { click: { x: 44, y: 181 }, observe: false })).details.status).toBe("refused");
  await f.browser.call("observe", { image_only: true });
  const zoom = await f.browser.call("observe", { zoom: { x: 24, y: 165, width: 41, height: 32 } });
  expect(zoom.content).toContainEqual(jpeg);
  expect(f.calls.find(c => c.name === "zoom")?.args).toMatchObject({ x1: 24, y1: 165, x2: 65, y2: 197 });
  const before = f.calls.length;
  expect((await f.browser.call("observe", { zoom: { x: 1, y: 1, width: 10, height: 10 } })).details.status).toBe("refused");
  expect(f.calls).toHaveLength(before);
  await f.browser.call("act", { click: { x: 74, y: 60 }, observe: false });
  const last = f.calls.filter(c => c.name === "click").at(-1)!;
  expect(last.args).toMatchObject({ x: 74, y: 60, from_zoom: true }); expect(last.args).not.toHaveProperty("capture_id");
});

test("closed or recycled native windows cannot receive input through an old focused browser", async () => {
  const f = fixture(); const opened = await f.browser.call("open", { url: "http://localhost/" });
  const hint = (opened.details.elements as { hint: string }[])[0].hint;
  f.setAlive(false);
  const result = await f.browser.call("act", { click: hint, observe: false });
  expect(result.details.status).toBe("refused"); expect(f.calls.some(c => c.name === "browser_click")).toBe(false);
  expect(f.calls.at(-1)?.name).toBe("transport_close");
});

test("an uncertain launch is attempted once and its explicit session is ended, not adopted or replayed", async () => {
  const f = fixture();
  f.setOverride(async name => { if (name === "browser_prepare") throw new Error("Native response lost after launch"); return undefined; });
  expect((await f.browser.call("open", { url: "http://localhost/" })).details.status).toBe("unknown");
  expect(f.calls.filter(c => c.name === "browser_prepare")).toHaveLength(1);
  expect(f.calls.at(-2)?.name).toBe("end_session"); expect(f.calls.at(-1)?.name).toBe("transport_close");
});

test("cancellation after input admission ends only the owned session and never replays", async () => {
  const f = fixture(); const opened = await f.browser.call("open", { url: "http://localhost/" });
  const hint = (opened.details.elements as { hint: string }[])[0].hint;
  const abort = new AbortController();
  f.setOverride(async name => { if (name === "browser_click") { abort.abort(); throw new Error("Cancelled after admission"); } return undefined; });
  expect((await f.browser.call("act", { click: hint, observe: false }, abort.signal)).details.status).toBe("unknown");
  expect(f.calls.filter(c => c.name === "browser_click")).toHaveLength(1);
  expect(f.calls.at(-1)?.name).toBe("transport_close");
});

test("pixel input and fresh zoom refuse when the observed page or window geometry changed", async () => {
  for (const operation of ["act", "observe"] as const) {
    const f = fixture(); await f.browser.call("open", { url: "http://localhost/" });
    f.setOverride(async (name, args) => name === "get_browser_state" && args.pid ? {
      content: [], structuredContent: { binding_quality: "exact", mutation_allowed: true, target_id: "new-bind",
        tabs: [{ tab_id: "new-tab", active: true, title: "Different page", url: "http://localhost/different" }] },
    } : undefined);
    const result = await f.browser.call(operation, operation === "act" ? { click: { x: 44, y: 181 }, observe: false } : { zoom: { x: 24, y: 165, width: 41, height: 32 } });
    expect(result.details.status).toBe("refused");
    expect(f.calls.some(c => ["click", "zoom"].includes(c.name))).toBe(false);
  }
  const f = fixture(); await f.browser.call("open", { url: "http://localhost/" });
  f.setOverride(async name => name === "list_windows" ? { content: [], structuredContent: {
    windows: [{ pid: 111, window_id: 22, bounds: { x: 70, y: 60, width: 1500, height: 932 } }],
  } } : undefined);
  expect((await f.browser.call("act", { click: { x: 44, y: 181 }, observe: false })).details.status).toBe("refused");
  expect(f.calls.some(c => c.name === "click")).toBe(false);
});
test("native metadata rebinding never replaces the target IDs behind existing aliases", async () => {
  const f = fixture(); const opened = await f.browser.call("open", { url: "http://localhost/" });
  const hint = (opened.details.elements as { hint: string }[])[0].hint;
  f.setOverride(async (name, args) => name === "get_browser_state" && args.pid ? {
    content: [], structuredContent: { binding_quality: "exact", mutation_allowed: true, target_id: "new-metadata-target",
      tabs: [{ tab_id: "new-metadata-tab", active: true, title: "Fixture", url: "http://localhost/" }] },
  } : undefined);
  await f.browser.call("tabs", {});
  expect((await f.browser.call("act", { click: hint, observe: false })).details.status).toBe("acted");
  expect(f.calls.find(c => c.name === "browser_click")?.args).toMatchObject({ target_id: "owned-target", tab_id: "owned-tab", ref: "p1:0" });
});
test("external tab changes retire pixels and hints before any input", async () => {
  const f = fixture(); const opened = await f.browser.call("open", { url: "http://localhost/" });
  const hint = (opened.details.elements as { hint: string }[])[0].hint;
  f.setOverride(async (name, args) => name === "get_browser_state" && args.pid ? {
    content: [], structuredContent: { binding_quality: "exact", mutation_allowed: true, target_id: "owned-target",
      tabs: [{ tab_id: "owned-tab", active: false }, { tab_id: "other-tab", active: true }] },
  } : undefined);
  expect((await f.browser.call("act", { click: hint, observe: false })).details.status).toBe("refused");
  expect((await f.browser.call("observe", { image_only: true })).details.status).toBe("refused");
  expect(f.calls.some(c => c.name === "browser_click")).toBe(false);
  f.setOverride(undefined);
  expect((await f.browser.call("act", { click: { x: 44, y: 181 }, observe: false })).details.status).toBe("refused");
  expect((await f.browser.call("act", { click: hint, observe: false })).details.status).toBe("refused");
});

test("native structured refusal stops input even when MCP isError is false", async () => {
  for (const state of [
    { effect: "refused", error: { code: "browser_action_unavailable" }, summary: "Cannot replace a numeric input" },
    { status: "refused", refusal: { code: "browser_consent_required" } },
  ]) {
    const f = fixture(); const opened = await f.browser.call("open", { url: "http://localhost/" });
    const hint = (opened.details.elements as { hint: string }[])[4].hint;
    f.setOverride(async name => name === "browser_type" ? { content: [], isError: false, structuredContent: state } : undefined);
    const result = await f.browser.call("act", { fill: hint, text: "0.5", observe: false });
    expect(result.details.status).toBe("refused"); expect(result.isError).toBe(true);
    expect(f.calls.filter(c => c.name === "browser_type")).toHaveLength(1);
    expect(f.calls.some(c => c.name === "end_session")).toBe(false);
    await f.browser.call("close", {});
  }
});

test("a structured refusal with delivered input is unknown and never replayed", async () => {
  const f = fixture(); const opened = await f.browser.call("open", { url: "http://localhost/" });
  const hint = (opened.details.elements as { hint: string }[])[4].hint;
  f.setOverride(async name => name === "browser_type" ? {
    content: [], isError: false, structuredContent: { effect: "refused", delivery: { delivered_count: 1 } },
  } : undefined);
  expect((await f.browser.call("act", { fill: hint, text: "0.5", observe: false })).details.status).toBe("unknown");
  expect(f.calls.filter(c => c.name === "browser_type")).toHaveLength(1);
  expect(f.calls.at(-1)?.name).toBe("transport_close");
});

test("a failed capture after a completed click is unknown, not a pre-input refusal", async () => {
  const f = fixture(); const opened = await f.browser.call("open", { url: "http://localhost/" });
  const hint = (opened.details.elements as { hint: string }[])[0].hint;
  f.setOverride(async name => name === "get_window_state" ? {
    content: [{ type: "text", text: "Native capture failed" }], isError: true, structuredContent: { status: "refused" },
  } : undefined);
  expect((await f.browser.call("act", { click: hint })).details.status).toBe("unknown");
  expect(f.calls.filter(c => c.name === "browser_click")).toHaveLength(1);
  expect(f.calls.at(-1)?.name).toBe("transport_close");
});

test("native session cleanup failure is reported as unknown even without browser input", async () => {
  const f = fixture(); await f.browser.call("open", { url: "http://localhost/" });
  f.setOverride(async name => name === "end_session" ? { content: [], isError: true } : undefined);
  expect((await f.browser.call("close", {})).details.status).toBe("unknown");
  expect((await f.browser.call("close", {})).details.status).toBe("unknown");
  expect((await f.browser.call("open", { url: "http://localhost/again" })).details.status).toBe("unknown");
  expect(f.calls.filter(c => c.name === "browser_prepare")).toHaveLength(1);
  expect(f.calls.at(-1)?.name).toBe("transport_close");
});
test("old crop, mixed selectors, out-of-bounds pixels and unsupported tab/key operations refuse before input", async () => {
  const f = fixture(); const opened = await f.browser.call("open", { url: "http://localhost/" });
  const hint = (opened.details.elements as { hint: string }[])[0].hint;
  const before = f.calls.length;
  for (const args of [{ click: hint, fill: hint, text: "bad" }, { click: { x: 500, y: 1 } }, { press: hint, key: "Enter" }, { close_tab: true }, { move: { x: 1, y: 1 } }])
    expect((await f.browser.call("act", args)).details.status).toBe("refused");
  expect((await f.browser.call("observe", { crop: { x: 0, y: 0, width: 10, height: 10 } })).details.status).toBe("refused");
  expect((await f.browser.call("open", { url: "http://localhost/again" })).details.status).toBe("refused");
  expect(f.calls).toHaveLength(before);
});

test("each overview and zoom raises only the live owned window, and reports the focus change", async () => {
  const f = fixture();
  const first = await f.browser.call("open", { url: "http://localhost/" });
  expect(first.details.foreground).toMatchObject({ route: "cua_bring_to_front", keyboard_focus_may_change: true,
    native: { landed_on_target: true, target_hwnd: "0x16" } });
  const beforeSnapshot = f.calls.findIndex(c => c.name === "get_browser_state" && c.args.target_id);
  expect(f.calls.findIndex(c => c.name === "bring_to_front")).toBeLessThan(beforeSnapshot);
  const before = f.calls.length;
  await f.browser.call("observe", { image_only: true });
  const imageCalls = f.calls.slice(before).map(c => c.name);
  expect(imageCalls.indexOf("bring_to_front")).toBeGreaterThanOrEqual(0);
  expect(imageCalls.indexOf("bring_to_front")).toBeLessThan(imageCalls.indexOf("get_window_state"));
  expect(f.calls.slice(before).some(c => c.name === "get_browser_state" && c.args.target_id)).toBe(false);
  const zoomStart = f.calls.length;
  const zoom = await f.browser.call("observe", { zoom: { x: 24, y: 165, width: 41, height: 32 } });
  const zoomCalls = f.calls.slice(zoomStart).map(c => c.name);
  expect(zoomCalls.indexOf("bring_to_front")).toBeGreaterThanOrEqual(0);
  expect(zoomCalls.indexOf("bring_to_front")).toBeLessThan(zoomCalls.indexOf("zoom"));
  expect(zoom.details.foreground).toMatchObject({ route: "cua_bring_to_front" });
  expect(f.calls.filter(c => c.name === "bring_to_front")).toHaveLength(3);
  expect(f.calls.filter(c => c.name === "bring_to_front").every(c => c.args.pid === 111 && c.args.window_id === 22)).toBe(true);
});

test("capture-free input and tab listing do not take foreground or renew hints", async () => {
  const f = fixture(); const first = await f.browser.call("open", { url: "http://localhost/" });
  const hint = (first.details.elements as { hint: string }[])[0].hint;
  const start = f.calls.length;
  expect((await f.browser.call("act", { click: hint, observe: false })).details.status).toBe("acted");
  await f.browser.call("tabs", {});
  expect(f.calls.slice(start).some(c => c.name === "bring_to_front")).toBe(false);
  f.setAlive(false);
  expect((await f.browser.call("observe", {})).details.status).toBe("refused");
  expect(f.calls.slice(start).some(c => c.name === "bring_to_front")).toBe(false);
});

test("foreground refusal stops capture; a partial raise is unknown and never retried", async () => {
  for (const raised of [false, true]) {
    const f = fixture(); await f.browser.call("open", { url: "http://localhost/" });
    const start = f.calls.length;
    f.setOverride(async name => name === "bring_to_front" ? { content: [{ type: "text", text: "Foreground unavailable" }],
      isError: true, structuredContent: { effect: "refused", landed_on_target: false, raised, restored: false } } : undefined);
    const result = await f.browser.call("observe", { image_only: true });
    expect(result.details.status).toBe(raised ? "unknown" : "refused");
    expect(f.calls.slice(start).filter(c => c.name === "bring_to_front")).toHaveLength(1);
    expect(f.calls.slice(start).some(c => c.name === "get_window_state")).toBe(false);
    expect(f.calls.slice(start).some(c => c.name === "end_session")).toBe(raised);
    await f.browser.call("close", {});
  }
});

test("a lost or wrong-target foreground result cannot yield a claimed current image", async () => {
  for (const mode of ["lost", "wrong-target"]) {
    const f = fixture(); await f.browser.call("open", { url: "http://localhost/" });
    const start = f.calls.length;
    f.setOverride(async name => {
      if (name !== "bring_to_front") return undefined;
      if (mode === "lost") throw new Error("Response lost after foreground dispatch");
      return { content: [], structuredContent: { landed_on_target: true, target_hwnd: "0x999", now_fg_hwnd: "0x999" } };
    });
    expect((await f.browser.call("observe", {})).details.status).toBe("unknown");
    expect(f.calls.slice(start).filter(c => c.name === "bring_to_front")).toHaveLength(1);
    expect(f.calls.slice(start).some(c => c.name === "get_window_state")).toBe(false);
    expect(f.calls.at(-1)?.name).toBe("transport_close");
  }
});
