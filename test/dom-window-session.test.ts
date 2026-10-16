import { expect, test, vi } from "vitest";
import { ComputerSession, type ComputerMode, type Driver } from "../src/session.ts";

async function fixture() {
  let life: string | undefined = "one", mode: ComputerMode = "yolo", enabled = true, serial = 0;
  let after: (() => void) | undefined, replace: ((value: Record<string, unknown>) => Record<string, unknown>) | undefined;
  const driver: Driver = {
    get domInspection() { return enabled; },
    identity: vi.fn(async () => life), close: vi.fn(async () => {}),
    call: vi.fn<Driver["call"]>(async (name, args) => {
      if (name === "list_windows") return { content: [], structuredContent: { windows: [{ pid: 42, window_id: 91 }] } };
      if (name === "start_session") return { content: [], structuredContent: { active: true, session: args.session } };
      if (name === "end_session") return { content: [], structuredContent: { active: false, session: args.session } };
      if (name === "get_window_state") return { content: [], structuredContent: { pid: 42, window_id: 91, snapshot_id: "ui", elements: [], elements_complete: true } };
      if (name !== "get_browser_state") throw Error(`Unexpected native call: ${name}`);
      if (!args.snapshot_format) return { content: [], structuredContent: { status: "ok", mode: "bind", binding_quality: "exact", endpoint_access_class: "driver_owned",
        target_id: "bt-one", tabs: [{ tab_id: "tab-one", active: true, title: "Fixture", url: "http://127.0.0.1/" }] } };
      if (args.geometry_ref) {
        const state = { status: "ok", mode: "element_geometry", target_id: "bt-one", tab_id: "tab-one",
          ref: args.geometry_ref, source_ref: args.geometry_ref, frame: { kind: "main" },
          coordinate_space: "frame_viewport_css_pixels", viewport: "layout", method: "isolated_cssom_border_box",
          native_pixel_mapping: "unavailable", atomic: false, connected: true, same_document: true,
          bounds: { x: 10.25, y: 20.5, width: 90, height: 30 }, scroll: { x: 0, y: 120 },
          visual_viewport: { offset_x: 0, offset_y: 0, page_x: 0, page_y: 120, width: 800, height: 600, scale: 1 } };
        after?.();
        return { content: [], structuredContent: replace ? replace(state) : state };
      }
      const id = `p${++serial}`;
      const state = { status: "ok", mode: "snapshot", target_id: "bt-one", tab_id: "tab-one", page: { url: "http://127.0.0.1/", title: "Fixture" },
        snapshot: { id, format: "dom_inspect_v1", complete: false, collection_complete: false, matched_count: 1, returned_count: 1, truncated: false,
          omitted: { nodes: 0, depth: 0, frames: 1, metadata: 0, text: 0, hidden_filtered: 0 }, scope: args.scope_ref ? "subtree" : "document" },
        elements: [{ ref: `${id}:0`, frame: { ref: "df-main", kind: "main" }, tag: "button", attributes: { "data-testid": "advance" }, text: "Advance", text_truncated: false,
          role: "button", name: "Advance", value: null, states: { disabled: false }, visibility: "visible", bounds_css: { x: 10, y: 20, width: 90, height: 30 }, coordinate_space: "document_css_pixels" }] };
      after?.();
      return { content: [], structuredContent: replace ? replace(state) : state };
    }),
  };
  const session = new ComputerSession(driver, () => mode);
  const ref = ((await session.windows()).details.state!.windows as { window_ref: string }[])[0].window_ref;
  const calls = () => vi.mocked(driver.call).mock.calls;
  return { session, ref, driver, calls, setLife(v: string | undefined) { life = v; }, setMode(v: ComputerMode) { mode = v; },
    setEnabled(v: boolean) { enabled = v; }, after(v: () => void) { after = v; }, replace(v: typeof replace) { replace = v; } };
}

test("window DOM uses one exact owned binding and gives readonly aliases, not input authority", async () => {
  const f = await fixture(), result = await f.session.observeDom(f.ref, { locator: { test_id: "advance" } });
  expect(result.details.status).toBe("observed");
  expect(result.details.dom?.elements[0].hint).toMatch(/^[a-z0-9]+:[a-z]+$/);
  expect(result.details.dom?.collection_complete).toBe(false);
  expect(result.details.ui).toBeUndefined(); expect(result.details.agent_image).toBeUndefined();
  expect(result.content.every(block => block.type === "text")).toBe(true);
  const input = await f.session.act({ window_ref: f.ref, observation_id: result.details.observation_id!, action: "click", x: 10, y: 20 });
  expect(input.details.status).toBe("refused");
  expect(f.calls().map(([name]) => name)).toEqual(["list_windows", "start_session", "get_browser_state", "get_browser_state"]);
  expect(f.calls().at(-1)?.[1]).toMatchObject({ snapshot_format: "dom_inspect_v1", include_screenshot: false, locator: { test_id: "advance" } });
});

test("unqualified native layout units cannot masquerade as CSS or native crop geometry", async () => {
  const f = await fixture(), result = await f.session.observeDom(f.ref);
  expect(result.details.dom?.elements[0].bounds_css).toBeNull();
  expect(result.details.dom?.geometry_status).toBe("unqualified_native_layout_units");
  expect(result.details.dom?.omitted.metadata).toBeGreaterThan(0);
  expect(result.details.dom?.complete).toBe(false);
});
test("cached DOM inspection and search do not walk, renew or claim full absence", async () => {
  const f = await fixture(), first = await f.session.observeDom(f.ref), id = first.details.observation_id!;
  const count = f.calls().length;
  expect((await f.session.checkDom(f.ref, id)).details.dom).toEqual(first.details.dom);
  const found = await f.session.inspectDom(f.ref, id, { operation: "search", query: "missing" });
  expect(found.details.dom?.elements).toEqual([]);
  expect(found.details.dom?.collection_complete).toBe(false);
  expect(found.details.dom?.returned_count).toBe(1);
  expect(f.calls()).toHaveLength(count);
  const cropped = await f.session.inspectDom(f.ref, id, { operation: "crop", hint: first.details.dom!.elements[0].hint });
  expect(cropped.details.status).toBe("refused");
  expect(cropped.content.every(block => block.type === "text")).toBe(true);
});

test("fresh scopes translate only current readonly hints, retire old aliases and retain the admitted tab", async () => {
  const f = await fixture(), first = await f.session.observeDom(f.ref), id = first.details.observation_id!;
  const hint = first.details.dom!.elements[0].hint;
  const scoped = await f.session.observeDom(f.ref, { scope: hint }, undefined, id);
  expect(scoped.details.status).toBe("observed");
  expect(f.calls().at(-1)?.[1]).toMatchObject({ target_id: "bt-one", tab_id: "tab-one", scope_ref: "p1:0" });
  expect(f.calls().filter(([, args]) => args.pid === 42 && args.snapshot_format === undefined && args.session)).toHaveLength(1);
  expect((await f.session.checkDom(f.ref, id)).details.status).toBe("refused");
  expect((await f.session.inspectDom(f.ref, scoped.details.observation_id!, { operation: "inspect", hint })).details.status).toBe("refused");
});

test("invalid model fields cannot retire a good snapshot or forward native capabilities", async () => {
  const f = await fixture(), first = await f.session.observeDom(f.ref), count = f.calls().length;
  expect((await f.session.observeDom(f.ref, { target_id: "foreign" } as never)).details.status).toBe("refused");
  expect(f.calls()).toHaveLength(count);
  expect((await f.session.checkDom(f.ref, first.details.observation_id!)).details.status).toBe("observed");
});

test.each(["safe", "reused", "closed", "disabled"] as const)("%s DOM cannot acquire or expose another source", async change => {
  const f = await fixture(), first = await f.session.observeDom(f.ref), count = f.calls().length;
  if (change === "safe") f.setMode("safe");
  if (change === "reused") f.setLife("two");
  if (change === "closed") f.setLife(undefined);
  if (change === "disabled") f.setEnabled(false);
  expect((await f.session.observeDom(f.ref)).details.status).toBe("refused");
  expect(f.calls()).toHaveLength(count);
  expect((await f.session.checkDom(f.ref, first.details.observation_id!)).details.status).toBe("refused");
});

test("cancellation and native target substitution withhold DOM data without replay", async () => {
  const f = await fixture(), abort = new AbortController();
  f.after(() => abort.abort());
  const cancelled = await f.session.observeDom(f.ref, {}, abort.signal);
  expect(cancelled.details.status).toBe("refused"); expect(cancelled.details.dom).toBeUndefined();
  f.after(() => {}); f.replace(value => ({ ...value, tab_id: "foreign" }));
  const invalid = await f.session.observeDom(f.ref);
  expect(invalid.details.status).toBe("refused"); expect(invalid.details.dom).toBeUndefined();
  expect(f.calls().filter(([, args]) => args.snapshot_format)).toHaveLength(2);
});

test("unknown native fields cannot escape bounded valid DOM text projections", async () => {
  const f = await fixture();
  f.replace(value => ({ ...value, snapshot: { ...value.snapshot as object, unknown: "x".repeat(90_000) },
    elements: (value.elements as Record<string, unknown>[]).map(row => ({ ...row, unknown: "x".repeat(90_000),
      frame: { ...row.frame as object, unknown: "x".repeat(90_000) }, bounds_css: { ...row.bounds_css as object, unknown: "x".repeat(90_000) } })) }));
  const result = await f.session.observeDom(f.ref);
  expect(result.details.status).toBe("observed");
  const body = result.content.filter(block => block.type === "text").map(block => block.text).join("\n");
  expect(body.length).toBeLessThan(24_500);
  expect(JSON.parse(body.slice(body.indexOf("\n") + 1))).toMatchObject({ status: "observed" });
  expect(JSON.stringify(result.details.dom)).not.toContain("unknown");
});
test("explicit CSS geometry uses the current readonly hint without minting image or input authority", async () => {
  const f = await fixture(), observed = await f.session.observeDom(f.ref), id = observed.details.observation_id!;
  const hint = observed.details.dom!.elements[0].hint, count = f.calls().length;
  const sampled = await f.session.sampleDomGeometry(f.ref, id, hint);
  expect(sampled.details.status).toBe("observed");
  expect(sampled.details.dom_geometry).toMatchObject({ window_ref: f.ref, observation_id: id, hint,
    frame: { ref: "df-main", kind: "main" }, coordinate_space: "frame_viewport_css_pixels", native_pixel_mapping: "unavailable",
    bounds: { x: 10.25, y: 20.5, width: 90, height: 30 } });
  expect(sampled.details.ui).toBeUndefined(); expect(sampled.details.agent_image).toBeUndefined();
  expect(sampled.details.action_capability).toBeUndefined(); expect(sampled.content.every(block => block.type === "text")).toBe(true);
  expect(JSON.stringify(sampled)).not.toMatch(/bt-one|tab-one|p1:0/);
  expect(f.calls()).toHaveLength(count + 1);
  expect(f.calls().at(-1)?.[1]).toMatchObject({ snapshot_format: "dom_inspect_v1", geometry_ref: "p1:0" });
  expect((await f.session.checkDom(f.ref, id)).details.dom?.elements[0].bounds_css).toBeNull();
  expect((await f.session.act({ window_ref: f.ref, observation_id: id, action: "click", x: 10, y: 20 })).details.status).toBe("refused");
});

test("unknown geometry hints and child frames refuse before native geometry dispatch", async () => {
  const f = await fixture(), observed = await f.session.observeDom(f.ref), id = observed.details.observation_id!;
  let count = f.calls().length;
  expect((await f.session.sampleDomGeometry(f.ref, id, "foreign:a")).details.status).toBe("refused");
  expect(f.calls()).toHaveLength(count);
  expect((await f.session.checkDom(f.ref, id)).details.status).toBe("observed");
  f.replace(value => ({ ...value, elements: (value.elements as Record<string, unknown>[]).map(row => ({
    ...row, frame: { ref: "df-child", kind: "iframe" }
  })) }));
  const child = await f.session.observeDom(f.ref); count = f.calls().length;
  expect((await f.session.sampleDomGeometry(f.ref, child.details.observation_id!, child.details.dom!.elements[0].hint)).details.status).toBe("refused");
  expect(f.calls()).toHaveLength(count);
});

test.each(["safe", "reused", "closed", "disabled", "cancelled"] as const)("%s source cannot sample CSS geometry", async change => {
  const f = await fixture(), observed = await f.session.observeDom(f.ref), count = f.calls().length;
  const abort = new AbortController();
  if (change === "safe") f.setMode("safe");
  if (change === "reused") f.setLife("two");
  if (change === "closed") f.setLife(undefined);
  if (change === "disabled") f.setEnabled(false);
  if (change === "cancelled") abort.abort();
  expect((await f.session.sampleDomGeometry(f.ref, observed.details.observation_id!, observed.details.dom!.elements[0].hint, abort.signal)).details.status).toBe("refused");
  expect(f.calls()).toHaveLength(count);
});

test("cancelled or substituted geometry retires the source without replay or leaked coordinates", async () => {
  const f = await fixture(), observed = await f.session.observeDom(f.ref), abort = new AbortController();
  const id = observed.details.observation_id!, hint = observed.details.dom!.elements[0].hint;
  f.after(() => abort.abort());
  const cancelled = await f.session.sampleDomGeometry(f.ref, id, hint, abort.signal);
  expect(cancelled.details.status).toBe("refused"); expect(cancelled.details.dom_geometry).toBeUndefined();
  f.after(() => {}); f.replace(undefined);
  const fresh = await f.session.observeDom(f.ref);
  f.replace(value => ({ ...value, tab_id: "foreign" }));
  const invalid = await f.session.sampleDomGeometry(f.ref, fresh.details.observation_id!, fresh.details.dom!.elements[0].hint);
  expect(invalid.details.status).toBe("refused"); expect(invalid.details.dom_geometry).toBeUndefined();
  expect((await f.session.checkDom(f.ref, fresh.details.observation_id!)).details.status).toBe("refused");
  expect(f.calls().filter(([, args]) => args.geometry_ref)).toHaveLength(2);
});
test("ordinary window reads retire DOM and fresh DOM retires ordinary input", async () => {
  const f = await fixture(), first = await f.session.observeDom(f.ref);
  await f.session.observe(f.ref, undefined, undefined, undefined, undefined, { granularity: "ui" });
  expect((await f.session.checkDom(f.ref, first.details.observation_id!)).details.status).toBe("refused");
  const fresh = await f.session.observeDom(f.ref);
  expect(fresh.details.status).toBe("observed");
  await f.session.close();
  expect((await f.session.checkDom(f.ref, fresh.details.observation_id!)).details.status).toBe("refused");
  expect(f.calls().at(-1)?.[0]).toBe("end_session");
});
