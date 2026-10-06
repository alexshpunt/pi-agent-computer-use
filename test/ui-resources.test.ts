import { expect, test, vi } from "vitest";
import sharp from "sharp";
import { ComputerSession, type Driver, type Content } from "../src/session.ts";

async function fixture() {
  let snapshot = 0;
  let mode: "safe" | "yolo" = "yolo";
  const raw = await sharp({ create: { width: 500, height: 320, channels: 3, background: "#eef4ff" } }).png().toBuffer();
  const image: Content = { type: "image", mimeType: "image/png", data: raw.toString("base64") };
  const driver: Driver = {
    identity: vi.fn(async target => `${target.window_id}:alive`), close: vi.fn(async () => {}),
    call: vi.fn<Driver["call"]>(async (name, args) => {
      if (name === "list_windows") return { content: [], structuredContent: { windows: [{ pid: 42, window_id: 91 }, { pid: 42, window_id: 92 }] } };
      if (name === "get_window_state") {
        const token = (i: number) => `s${++snapshot}:${i}`;
        return { content: [image], structuredContent: { screenshot_width: 500, screenshot_height: 320,
          window_bounds: { x: 80, y: 90, width: 1000, height: 640 }, elements_complete: false, truncated: true, truncation_reason: "max_elements",
          elements: [
            { element_index: 1, element_token: token(1), role: "Group", label: "Left", depth: 0 },
            { element_index: 2, element_token: token(2), parent_index: 1, role: "Button", label: "Save", enabled: true, actions: ["invoke"],
              frame: { x: 180, y: 190, w: 100, h: 40 }, screenshot_frame: { x: 50, y: 50, w: 50, h: 20 } },
            { element_index: 3, element_token: token(3), parent_index: 1, role: "Button", label: "Save", enabled: false,
              screenshot_frame: { x: 150, y: 50, w: 50, h: 20 } },
            { element_index: 4, element_token: token(4), role: "Custom", label: "Canvas" },
          ].slice(0, Number(args.max_elements)) } };
      }
      if (name === "zoom") return { content: [{ type: "image", mimeType: "image/jpeg", data: (await sharp(raw).extract({ left: 40, top: 40, width: 70, height: 40 }).jpeg().toBuffer()).toString("base64") }], structuredContent: { width: 70, height: 40, x_offset: 40, y_offset: 40 } };
      return { content: [], structuredContent: { path: "ax", effect: "confirmed", verified: true } };
    }),
  };
  const retained: Content[] = [];
  const session = new ComputerSession(driver, () => mode, undefined, undefined, image => retained.push(image));
  const windows = (await session.windows()).details.state!.windows as { window_ref: string }[];
  const ref = windows[0].window_ref;
  return { session, driver, raw, retained, ref, other: windows[1].window_ref, setMode: (value: "safe" | "yolo") => { mode = value; } };
}
function ui(result: Awaited<ReturnType<ComputerSession["observe"]>>) { return result.details.ui!; }

test("a selected overview region is local, bounded, read-only and keeps the input observation", async () => {
  const f = await fixture();
  const view = await f.session.observe(f.ref, undefined, undefined, undefined, undefined,
    { guides: { grid: true, region: true, action: true } });
  const before = nativeCalls(f.driver);
  const marked = await f.session.observe(f.ref, undefined, undefined, undefined,
    { operation: "region", observation_id: view.details.observation_id!, region: { x: 30, y: 40, width: 180, height: 110 } });
  expect(marked.details.status).toBe("observed");
  expect(marked.details.observation_id).toBe(view.details.observation_id);
  expect(marked.content.filter(b => b.type === "image")).toHaveLength(1);
  expect(marked.details.agent_image).toMatchObject({ annotation: { guides: { region: { status: "shown" } } } });
  expect(nativeCalls(f.driver)).toEqual(before);
  const invalid = await f.session.observe(f.ref, undefined, undefined, undefined,
    { operation: "region", observation_id: view.details.observation_id!, region: { x: 490, y: 30, width: 50, height: 20 } });
  expect(invalid.details.status).toBe("refused");
  expect(nativeCalls(f.driver)).toEqual(before);
  expect((await f.session.act({ window_ref: f.ref, observation_id: view.details.observation_id!, action: "click", hint: ui(view).elements[1].hint })).details.status).toBe("delivered");
});
test("completed token target marks follow window movement, while an uncertain pointer never creates a mark", async () => {
  const f = await fixture(); const call = f.driver.call; let moved = false; let uncertain = false;
  f.driver.call = vi.fn(async (name, args, signal) => {
    const result = await call(name, args, signal);
    if (name === "get_window_state") {
      const state = result.structuredContent!;
      const dx = moved ? 300 : 0; const dy = moved ? 200 : 0;
      state.window_bounds = { x: 80 + dx, y: 90 + dy, width: 1000, height: 640 };
      const elements = state.elements as Record<string, unknown>[];
      elements.unshift({ element_index: 0, element_token: "root", frame: { x: 80 + dx, y: 90 + dy, w: 1000, h: 640 },
        screenshot_frame: { x: -1, y: -1, w: 501, h: 321 } });
      for (const e of elements.slice(1)) if (e.frame) { const r = e.frame as { x: number; y: number }; r.x += dx; r.y += dy; }
    }
    if (name === "click" && uncertain) return { content: [], structuredContent: { status: "unknown" } };
    return result;
  });
  const options = { guides: { grid: false, region: false, action: true } };
  const first = await f.session.observe(f.ref, undefined, undefined, undefined, undefined, options);
  const target = ui(first).elements.find(e => e.name === "Save" && e.enabled)!;
  expect((await f.session.act({ window_ref: f.ref, observation_id: first.details.observation_id!, action: "click", hint: target.hint })).details.status).toBe("delivered");
  moved = true;
  const after = await f.session.observe(f.ref, undefined, undefined, undefined, undefined, options);
  const annotation = after.details.agent_image!.annotation as { guides: { action: { status: string; basis: string; region: { x: number } } } };
  expect(annotation.guides.action).toMatchObject({ status: "shown", basis: "completed_native_token_target" });
  expect(annotation.guides.action.region.x).toBeCloseTo(99 / (998 / 500) - 4);
  uncertain = true;
  expect((await f.session.act({ window_ref: f.ref, observation_id: after.details.observation_id!, action: "click", hint: ui(after).elements.find(e => e.name === "Save" && e.enabled)!.hint })).details.status).toBe("unknown");
  const last = await f.session.observe(f.ref, undefined, undefined, undefined, undefined, options);
  expect(last.details.agent_image).toMatchObject({ annotation: { guides: { action: { status: "unavailable" } } } });
});
function nativeCalls(driver: Driver) { return vi.mocked(driver.call).mock.calls.map(([name]) => name); }

test("dense tool text remains valid bounded JSON while structured resources stay complete", async () => {
  const f = await fixture(); const native = f.driver.call;
  f.driver.call = vi.fn(async (name, args, signal) => {
    const result = await native(name, args, signal);
    if (name === "get_window_state") {
      result.structuredContent!.elements = Array.from({ length: 200 }, (_, i) => ({ element_index: i, element_token: `dense:${i}`, label: "x".repeat(1024), value: "v".repeat(1024) }));
      result.structuredContent!.tree_markdown = "t".repeat(32000);
    }
    return result;
  });
  const view = await f.session.observe(f.ref);
  const text = view.content[0]; if (text.type !== "text") throw Error("Missing text");
  const visible = JSON.parse(text.text.slice(text.text.indexOf("{")));
  expect(text.text.length).toBeLessThan(25000); expect(visible.ui.elements.length).toBeGreaterThan(0);
  expect(visible.text_projection).toMatchObject({ ui_elements: expect.any(Number), full_ui_elements: 200 });
  expect(ui(view).elements).toHaveLength(200); expect(ui(view).elements[0].name).toHaveLength(1024);
});

test("invalid capture and conflicting inspection filters preserve the current snapshot", async () => {
  const f = await fixture(); const view = await f.session.observe(f.ref); const before = nativeCalls(f.driver);
  const invalid = await f.session.observe(f.ref, undefined, undefined, undefined, undefined, { max_elements: 0 });
  expect(invalid.details.status).toBe("refused");
  for (const operation of ["inspect", "highlight", "crop"] as const) {
    const result = await f.session.observe(f.ref, undefined, undefined, undefined, {
      operation, observation_id: view.details.observation_id!, hint: ui(view).elements[1].hint, query: "Missing",
    });
    expect(result.details.status).toBe("refused");
  }
  expect(nativeCalls(f.driver)).toEqual(before); expect(f.driver.close).not.toHaveBeenCalled();
  expect((await f.session.observe(f.ref, undefined, undefined, undefined, {
    operation: "inspect", observation_id: view.details.observation_id!, hint: ui(view).elements[1].hint,
  })).details.status).toBe("observed");
});

test("render status describes this image, not a previous annotation", async () => {
  const { annotateUi } = await import("../src/ui-resources.ts");
  const f = await fixture(); const view = await f.session.observe(f.ref); const resource = structuredClone(ui(view));
  expect(resource.elements[1].hint_display).toBe("shown");
  const result = await annotateUi({ type: "image", data: f.raw.toString("base64"), mimeType: "image/png" }, resource, 500, 320, false);
  expect(resource.elements[1].hint_display).toBe("off"); expect(result.annotation.labels).toHaveLength(0);
  expect(resource.elements[2].hint_display).toBe("disabled"); expect(resource.elements[3].hint_display).toBe("no_bounds");
});

test("scoped label placement respects controls excluded from the projection", async () => {
  const { annotateUi, projectUi } = await import("../src/ui-resources.ts");
  const f = await fixture(); const view = await f.session.observe(f.ref); const resource = structuredClone(ui(view));
  const selected = resource.elements[1];
  resource.elements[2].bounds.window_image = { x: 40, y: 25, width: 80, height: 25 };
  const projected = projectUi(resource, { operation: "highlight", observation_id: resource.observation_id, hint: selected.hint });
  const result = await annotateUi({ type: "image", data: f.raw.toString("base64"), mimeType: "image/png" }, projected, 500, 320, true, selected.hint, resource.elements);
  expect(result.annotation.labels[0].region.y).toBeGreaterThanOrEqual(70);
  expect(projected.elements[0].element_token).toBe(selected.element_token);
});

test("hint connectors do not cross control contents when the badge is below", async () => {
  const { annotateUi, projectUi } = await import("../src/ui-resources.ts");
  const f = await fixture(); const view = await f.session.observe(f.ref); const resource = structuredClone(ui(view));
  resource.elements[2].bounds.window_image = { x: 40, y: 25, width: 80, height: 25 };
  const projected = projectUi(resource, { operation: "highlight", observation_id: resource.observation_id, hint: resource.elements[1].hint });
  const result = await annotateUi({ type: "image", data: f.raw.toString("base64"), mimeType: "image/png" }, projected, 500, 320, true, undefined, resource.elements);
  if (result.image.type !== "image") throw Error("Missing image");
  const interior = { left: 51, top: 51, width: 48, height: 18 };
  const marked = await sharp(Buffer.from(result.image.data, "base64")).extract(interior).removeAlpha().raw().toBuffer();
  const original = await sharp(f.raw).extract(interior).removeAlpha().raw().toBuffer();
  expect(marked.equals(original)).toBe(true);
});
test("resources preserve native identity, duplicate names, parent links and distinct coordinate spaces", async () => {
  const f = await fixture(); const view = await f.session.observe(f.ref); const resource = ui(view);
  expect(resource).toMatchObject({ window_ref: f.ref, observation_id: view.details.observation_id, complete: false });
  const saves = resource.elements.filter(e => e.name === "Save");
  expect(saves).toHaveLength(2); expect(saves[0].hint).not.toBe(saves[1].hint);
  expect(saves[0]).toMatchObject({ enabled: true, actions: ["invoke"], parent_hint: resource.elements[0].hint,
    bounds: { native_screen: { x: 180, y: 190, width: 100, height: 40 }, window_image: { x: 50, y: 50, width: 50, height: 20 } } });
  expect(resource.elements[3]).toMatchObject({ enabled: null, bounds: {}, actions: [] });
});

test("local search and scope keep the snapshot without another native walk or input", async () => {
  const f = await fixture(); const view = await f.session.observe(f.ref); const before = nativeCalls(f.driver);
  const search = await f.session.observe(f.ref, undefined, undefined, undefined, { operation: "search", observation_id: view.details.observation_id!, query: "Save" });
  expect(ui(search).elements).toHaveLength(2); expect(search.details.observation_id).toBe(view.details.observation_id);
  const scoped = await f.session.observe(f.ref, undefined, undefined, undefined, { operation: "scope", observation_id: view.details.observation_id!, hint: ui(view).elements[0].hint });
  expect(ui(scoped).elements.map(e => e.name)).toEqual(["Left", "Save", "Save"]);
  expect(nativeCalls(f.driver)).toEqual(before);
  const absent = await f.session.observe(f.ref, undefined, undefined, undefined, { operation: "search", observation_id: view.details.observation_id!, query: "Missing" });
  expect(ui(absent)).toMatchObject({ complete: false, matches: 0 });
});

test("hints annotate only one delivered image and retain the exact raw PNG privately", async () => {
  const f = await fixture(); const view = await f.session.observe(f.ref); const images = view.content.filter(b => b.type === "image");
  expect(images).toHaveLength(1); expect(images[0].data).not.toBe(f.raw.toString("base64"));
  expect(f.retained).toContainEqual({ type: "image", mimeType: "image/png", data: f.raw.toString("base64") });
  expect(JSON.stringify(view.details)).not.toContain(f.raw.toString("base64"));
  expect(view.details.agent_image).toMatchObject({ route: "cua_native_ui_hints", annotation: { enabled: true, labels: expect.any(Array) } });
  expect(ui(view).elements[3].hint_display).toBe("no_bounds");
});

test("disabled, foreign, retired and conflicting hints never reach native input", async () => {
  const f = await fixture(); const first = await f.session.observe(f.ref); const resource = ui(first);
  const input = (hint: string, observation_id = first.details.observation_id!) => ({ window_ref: f.ref, observation_id, action: "click" as const, hint });
  const before = nativeCalls(f.driver).length;
  expect((await f.session.act(input(resource.elements[2].hint))).details.status).toBe("refused");
  expect((await f.session.act({ ...input(resource.elements[1].hint), element_token: resource.elements[1].element_token })).details.status).toBe("refused");
  const other = await f.session.observe(f.other);
  expect((await f.session.act(input(ui(other).elements[1].hint))).details.status).toBe("refused");
  const latest = await f.session.observe(f.ref);
  expect((await f.session.act(input(resource.elements[1].hint, latest.details.observation_id!))).details.status).toBe("refused");
  expect(nativeCalls(f.driver).slice(before).every(name => name === "get_window_state")).toBe(true);
  const selected = ui(latest).elements[1];
  expect((await f.session.act(input(selected.hint, latest.details.observation_id!))).details.status).toBe("delivered");
  expect(f.driver.call).toHaveBeenLastCalledWith("click", expect.objectContaining({ element_token: selected.element_token }), undefined);
  expect((await f.session.act(input(selected.hint, latest.details.observation_id!))).details.status).toBe("refused");
});

test("keyboard-only commands do not claim pixel-coordinate grounding", async () => {
  const f = await fixture(); const view = await f.session.observe(f.ref);
  const result = await f.session.act({window_ref:f.ref,observation_id:view.details.observation_id!,action:"key",key:"a"});
  expect(result.details.status).toBe("delivered");
  expect(result.details.state?.coordinate_grounding).toBeUndefined();
});

test("Safe, cancellation and source closure withhold local resources and images", async () => {
  const f = await fixture(); const view = await f.session.observe(f.ref); const before = nativeCalls(f.driver);
  const request = { operation: "highlight" as const, observation_id: view.details.observation_id!, hint: ui(view).elements[1].hint };
  f.setMode("safe");
  const denied = await f.session.observe(f.ref, undefined, undefined, undefined, request);
  f.setMode("yolo"); const abort = new AbortController(); abort.abort();
  const cancelled = await f.session.observe(f.ref, abort.signal, undefined, undefined, request);
  f.driver.identity = vi.fn(async () => undefined);
  const closed = await f.session.observe(f.ref, undefined, undefined, undefined, request);
  for (const result of [denied, cancelled, closed]) {
    expect(result.details.status).toBe("refused"); expect(result.details.ui).toBeUndefined();
    expect(result.content.every(b => b.type === "text")).toBe(true);
  }
  expect(nativeCalls(f.driver)).toEqual(before);
});

for (const effect of ["refused", "partial"] as const) test(`hint input reports native ${effect} without replay`, async () => {
  const f = await fixture(); const view = await f.session.observe(f.ref); const call = f.driver.call;
  f.driver.call = vi.fn(async (name, args, signal) => name === "click" ? { content: [], structuredContent: { effect } } : call(name, args, signal));
  const action = { window_ref: f.ref, observation_id: view.details.observation_id!, action: "click" as const, hint: ui(view).elements[1].hint };
  expect((await f.session.act(action)).details.status).toBe(effect === "refused" ? "refused" : "unknown");
  expect((await f.session.act(action)).details.status).toBe("refused");
  expect(nativeCalls(f.driver).filter(name => name === "click")).toHaveLength(1);
});

test("element crop is read-only, uses proven screenshot bounds and consumes input authority", async () => {
  const f = await fixture(); const view = await f.session.observe(f.ref); const selected = ui(view).elements[1];
  const crop = await f.session.observe(f.ref, undefined, undefined, undefined, { operation: "crop", observation_id: view.details.observation_id!, hint: selected.hint });
  expect(crop.details.status).toBe("observed");
  expect(f.driver.call).toHaveBeenCalledWith("zoom", expect.objectContaining({ x1: 50, y1: 50, x2: 100, y2: 70 }), undefined);
  expect(nativeCalls(f.driver)).not.toContain("click");
  expect((await f.session.act({ window_ref: f.ref, observation_id: view.details.observation_id!, action: "click", hint: selected.hint })).details.status).toBe("refused");
});

test("image eviction preserves structural inspection but never substitutes another window's pixels", async () => {
  const f = await fixture(); const first = await f.session.observe(f.ref); const call = f.driver.call;
  f.driver.call = vi.fn(async (name, args, signal) => name === "list_windows" ? {
    content: [], structuredContent: { windows: [91, 92, 93, 94].map(window_id => ({ pid: 42, window_id })) },
  } : call(name, args, signal));
  const windows = (await f.session.windows()).details.state!.windows as { window_ref: string }[];
  for (const row of windows.slice(1)) await f.session.observe(row.window_ref);
  const before = nativeCalls(f.driver);
  const hint = ui(first).elements[1].hint;
  const inspect = await f.session.observe(f.ref, undefined, undefined, undefined, { operation: "inspect", observation_id: first.details.observation_id!, hint });
  expect(ui(inspect).elements[0].hint).toBe(hint);
  const image = await f.session.observe(f.ref, undefined, undefined, undefined, { operation: "highlight", observation_id: first.details.observation_id!, hint });
  expect(image.details.status).toBe("refused"); expect(image.content.every(b => b.type === "text")).toBe(true);
  expect(nativeCalls(f.driver)).toEqual(before);
});

test("native limits are explicit, while disabled annotation returns exact native bytes", async () => {
  const f = await fixture(); const view = await f.session.observe(f.ref, undefined, undefined, undefined, undefined, { max_elements: 2, max_depth: 4, hints: false });
  expect(ui(view).elements).toHaveLength(2);
  expect(f.driver.call).toHaveBeenLastCalledWith("get_window_state", expect.objectContaining({ max_elements: 2, max_depth: 4 }), undefined);
  expect(view.content.filter(b => b.type === "image")).toContainEqual({ type: "image", mimeType: "image/png", data: f.raw.toString("base64") });
});
