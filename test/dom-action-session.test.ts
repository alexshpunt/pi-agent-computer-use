import { expect, test, vi } from "vitest";
import { ComputerSession, type ComputerMode, type Driver, type DriverResult } from "../src/session.ts";
import type { DomActionCommand } from "../src/dom-action.ts";

const dispatched = (): DriverResult => ({ content: [], structuredContent: {
  format: "dom_action_v1", status: "dispatched", input_route: "dom_event", trusted: false, atomic: false, native_pixel_mapping: "unavailable",
  action_result: { effect: "unverifiable", route: "dom", delivery: { mode: "unknown" } },
  progress: { status: "dispatched", reason: null, attempted_steps: ["click"], acknowledged_steps: ["click"], in_flight: null,
    mutation_attempted: true, effects: "unverified", automatic_retry: false, cleanup: "confirmed" },
  observed: [{ step: "click", observed: { activation_invoked: true } }], refusal: null,
  limitations: ["programmatic_dom_semantics_only", "no_css_hover_proof", "no_trusted_key_defaults", "no_application_success_proof"] } });
async function fixture() {
  let life: string | undefined = "one", mode: ComputerMode = "yolo", qualified = true;
  let native = async (): Promise<DriverResult> => dispatched();
  const driver: Driver = { domInspection: true, get domActions() { return qualified; },
    identity: vi.fn(async () => life), close: vi.fn(async () => {}),
    call: vi.fn<Driver["call"]>(async (name, args) => {
      if (name === "list_windows") return { content: [], structuredContent: { windows: [{ pid: 42, window_id: 91 }] } };
      if (name === "start_session") return { content: [], structuredContent: { active: true, session: args.session } };
      if (name === "end_session") return { content: [], structuredContent: { active: false, session: args.session } };
      if (name === "browser_dom_action") return native();
      if (name !== "get_browser_state") throw Error(`Unexpected call ${name}`);
      if (!args.snapshot_format) return { content: [], structuredContent: { status: "ok", mode: "bind", binding_quality: "exact", endpoint_access_class: "driver_owned",
        target_id: "bt-one", tabs: [{ tab_id: "tab-one", active: true, title: "Fixture", url: "http://127.0.0.1/" }] } };
      return { content: [], structuredContent: { status: "ok", mode: "snapshot", target_id: "bt-one", tab_id: "tab-one", page: { url: "http://127.0.0.1/", title: "Fixture" },
        snapshot: { id: "p1", format: "dom_inspect_v1", complete: true, collection_complete: true, matched_count: 1, returned_count: 1, truncated: false,
          omitted: { nodes: 0, depth: 0, frames: 0, metadata: 0, text: 0, hidden_filtered: 0 }, scope: "document" },
        elements: [{ ref: "p1:0", frame: { ref: "df-main", kind: "main" }, tag: "button", attributes: {}, text: "Save", text_truncated: false,
          role: "button", name: "Save", value: null, states: {}, visibility: "visible", bounds_css: null, coordinate_space: "document_css_pixels" }] } };
    }) };
  const session = new ComputerSession(driver, () => mode);
  const ref = ((await session.windows()).details.state!.windows as { window_ref: string }[])[0].window_ref;
  const observed = await session.observeDom(ref), id = observed.details.observation_id!;
  const command: DomActionCommand = { action: "dom", source_hint: observed.details.dom!.elements[0].hint, input_route: "dom_event",
    request: { action: "click", locator: { role: "button", name: "Save" }, timeout_ms: 1000 } };
  return { session, ref, id, command, driver, calls: () => vi.mocked(driver.call).mock.calls.filter(([name]) => name === "browser_dom_action"),
    setLife(value: string | undefined) { life = value; }, setMode(value: ComputerMode) { mode = value; }, setQualified(value: boolean) { qualified = value; },
    reply(fn: typeof native) { native = fn; } };
}

test("explicit DOM intent uses private document context, consumes its snapshot and never dispatches twice", async () => {
  const f = await fixture(), result = await f.session.actDom(f.ref, f.id, f.command);
  expect(result.details.status).toBe("delivered");
  expect(result.details.dom_action?.progress.acknowledged_steps).toEqual(["click"]);
  expect(f.calls()).toHaveLength(1);
  expect(f.calls()[0][1]).toMatchObject({ target_id: "bt-one", tab_id: "tab-one", source_ref: "p1:0", input_route: "dom_event", request: f.command.request });
  expect(JSON.stringify(result)).not.toMatch(/bt-one|tab-one|p1:0/);
  expect((await f.session.actDom(f.ref, f.id, f.command)).details.status).toBe("refused");
  expect((await f.session.checkDom(f.ref, f.id)).details.status).toBe("refused");
  expect(f.calls()).toHaveLength(1);
});
test.each(["safe", "reused", "closed", "unqualified", "cancelled", "foreign_hint", "invalid"])("%s refuses before native DOM mutation", async change => {
  const f = await fixture(), abort = new AbortController();
  if (change === "safe") f.setMode("safe");
  if (change === "reused") f.setLife("two");
  if (change === "closed") f.setLife(undefined);
  if (change === "unqualified") f.setQualified(false);
  if (change === "cancelled") abort.abort();
  if (change === "foreign_hint") f.command.source_hint = "foreign:a";
  if (change === "invalid") (f.command.request as any).x = 10;
  expect((await f.session.actDom(f.ref, f.id, f.command, abort.signal)).details.status).toBe("refused");
  expect(f.calls()).toHaveLength(0);
});
test("a lost transport or malformed reply stays unknown and cannot replay", async () => {
  for (const reply of [async () => { throw Error("lost acknowledgement"); }, async () => ({ ...dispatched(), structuredContent: { bad: true } })]) {
    const f = await fixture(); f.reply(reply);
    expect((await f.session.actDom(f.ref, f.id, f.command)).details.status).toBe("unknown");
    expect((await f.session.actDom(f.ref, f.id, f.command)).details.status).toBe("refused");
    expect(f.calls()).toHaveLength(1);
  }
});
test("native refusal prose cannot leak the provider's private binding or document refs", async () => {
  const f = await fixture();
  f.reply(async () => {
    const result = dispatched(), state = result.structuredContent!;
    Object.assign(state, { status: "refused", refusal: { code: "browser_binding_stale", message: "target bt-one source p1:0 tab-one" }, observed: [],
      action_result: { effect: "refused", route: "dom", error: { code: "browser_binding_stale", hint: "target bt-one source p1:0 tab-one" } } });
    Object.assign(state.progress as object, { status: "refused", reason: "dom_action_source_changed", attempted_steps: [], acknowledged_steps: [], mutation_attempted: false, cleanup: "not_started" });
    return result;
  });
  const result = await f.session.actDom(f.ref, f.id, f.command);
  expect(result.details.status).toBe("refused");
  expect(result.details.dom_action?.refusal?.code).toBe("browser_binding_stale");
  expect(JSON.stringify(result)).not.toMatch(/bt-one|tab-one|p1:0/);
});
test("a valid native prefix survives a failed post-dispatch lifetime check", async () => {
  const f = await fixture();
  f.reply(async () => { vi.mocked(f.driver.identity).mockRejectedValueOnce(Error("identity unavailable")); return dispatched(); });
  const result = await f.session.actDom(f.ref, f.id, f.command);
  expect(result.details.status).toBe("unknown");
  expect(result.details.dom_action?.progress.acknowledged_steps).toEqual(["click"]);
  expect(f.calls()).toHaveLength(1);
});
test("a valid native prefix survives cancellation after dispatch without new input", async () => {
  const f = await fixture(), abort = new AbortController();
  f.reply(async () => { abort.abort(); return dispatched(); });
  const result = await f.session.actDom(f.ref, f.id, f.command, abort.signal);
  expect(result.details.status).toBe("unknown");
  expect(result.details.dom_action?.progress.acknowledged_steps).toEqual(["click"]);
  expect(f.calls()).toHaveLength(1);
});
