import { validateDomRead, type DomLocator } from "./dom-inspection.ts";

const actions = ["click", "double_click", "right_click", "hover", "fill", "type", "press", "check", "uncheck", "select_option", "focus", "scroll_into_view"] as const;
/** Closed native locator intent. A DOM reference supplies document context, not the action target. */
export interface DomActionRequest {
  action: typeof actions[number]; locator: DomLocator; timeout_ms?: number;
  text?: string; key?: string; values?: string[]; dwell_ms?: number;
}
/** Explicit DOM Insert intent. source_hint pins its inspected document, never a target node. */
export interface DomActionCommand {
  action: "dom"; source_hint: string; input_route: "dom_event" | "trusted"; request: DomActionRequest;
}
/** Validate a complete explicit intent without accepting native identities, coordinates or JavaScript. */
export function validateDomActionCommand(value: unknown): DomActionCommand {
  try {
    const raw = object(value);
    fields(raw, ["action", "source_hint", "input_route", "request"]);
    check(raw.action === "dom" && typeof raw.source_hint === "string" && raw.source_hint.length <= 128 &&
      /^[a-z0-9]+:[a-z]+$/.test(raw.source_hint) && typeof raw.input_route === "string" && ["dom_event", "trusted"].includes(raw.input_route));
    const request = validateDomActionRequest(raw.request);
    return { action: "dom", source_hint: raw.source_hint, input_route: raw.input_route as DomActionCommand["input_route"], request };
  } catch { throw Error("dom_action_invalid_request"); }
}
/** Text-free execution prefix; an acknowledgement never proves an application effect. */
export interface DomActionProgress {
  status: string; reason: string | null; attempted_steps: string[]; acknowledged_steps: string[];
  in_flight: string | null; mutation_attempted: boolean; effects: "unverified"; automatic_retry: false;
  cleanup: "not_started" | "confirmed" | "unconfirmed";
}
/** Bounded closed receipt from the native DOM action route, not a live element state. */
export interface DomActionReceipt {
  format: "dom_action_v1"; status: "dispatched" | "refused"; input_route: "dom_event" | "trusted" | null;
  trusted: false; atomic: false; native_pixel_mapping: "unavailable";
  action_result: Record<string, unknown>; progress: DomActionProgress;
  observed: { step: string; observed: Record<string, boolean> }[];
  refusal: { code: string; message: string } | null; limitations: string[];
}
function check(condition: unknown): asserts condition { if (!condition) throw Error("invalid_dom_action_result"); }
function object(value: unknown): Record<string, unknown> {
  check(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function fields(value: Record<string, unknown>, keys: string[], required = keys) {
  check(Object.keys(value).every(key => keys.includes(key)) && required.every(key => Object.hasOwn(value, key)));
}
const identifier = (value: unknown, max: number): value is string => typeof value === "string" && value.length <= max && /^[a-z0-9_]+$/.test(value);
const bounded = (value: unknown, max: number): value is string => typeof value === "string" && Buffer.byteLength(value) <= max;
const integer = (value: unknown, max: number) => Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= max;
const steps = new Set(["click", "dblclick", "contextmenu", "pointerover", "mouseover", "pointerenter", "mouseenter", "focus", "scroll_into_view", "set_checked", "beforeinput", "fill", "insert_text", "input", "keydown", "keyup", "select_values", "change"]);

/** Validate the same closed bounded request as native, before consuming a source observation. */
export function validateDomActionRequest(value: unknown): DomActionRequest {
  try {
    const raw = object(value), action = raw.action;
    check(actions.includes(action as DomActionRequest["action"]));
    const parameter = action === "hover" ? "dwell_ms" : ["fill", "type"].includes(String(action)) ? "text" : action === "press" ? "key" : action === "select_option" ? "values" : undefined;
    fields(raw, ["action", "locator", "timeout_ms", ...(parameter ? [parameter] : [])], ["action", "locator", ...(parameter ? [parameter] : [])]);
    const locator = validateDomRead({ locator: raw.locator }).locator;
    check(locator && Object.keys(locator).length > 0);
    if (raw.timeout_ms !== undefined) check(integer(raw.timeout_ms, 10000));
    if (parameter === "dwell_ms") check(integer(raw.dwell_ms, 10000));
    if (parameter === "text") check(typeof raw.text === "string" && [...raw.text].length <= 2000 && !raw.text.includes("\0"));
    if (parameter === "key") check(typeof raw.key === "string" && raw.key.length > 0 && [...raw.key].length <= 64 && !/[\x00-\x1f\x7f]/.test(raw.key));
    if (parameter === "values") check(Array.isArray(raw.values) && raw.values.length > 0 && raw.values.length <= 32 &&
      raw.values.every(value => typeof value === "string" && [...value].length <= 256 && !value.includes("\0")) && new Set(raw.values).size === raw.values.length);
    check(Buffer.byteLength(JSON.stringify(raw)) <= 32 * 1024);
    return structuredClone(raw) as unknown as DomActionRequest;
  } catch { throw Error("dom_action_invalid_request"); }
}
/** Check discovery for the separately qualified native action surface; metadata never grants permission. */
export function hasDomActionSchema(value: unknown): boolean {
  try {
    const schema = object(value), properties = object(schema.properties);
    const required = ["session", "target_id", "tab_id", "source_ref", "input_route", "request"];
    check(schema.type === "object" && schema.additionalProperties === false && Array.isArray(schema.required) &&
      schema.required.length === required.length && required.every(key => (schema.required as unknown[]).includes(key)));
    fields(properties, required);
    for (const key of ["session", "target_id", "tab_id", "source_ref"]) check(object(properties[key]).type === "string");
    const route = object(properties.input_route), routes = route.enum;
    check(route.type === "string" && Array.isArray(routes) && routes.length === 2 && routes.includes("dom_event") && routes.includes("trusted"));
    const request = object(properties.request), params = object(request.properties);
    check(request.type === "object" && request.additionalProperties === false && Array.isArray(request.required) &&
      request.required.length === 2 && request.required.includes("action") && request.required.includes("locator"));
    const action = object(params.action), kinds = action.enum;
    check(action.type === "string" && Array.isArray(kinds) && kinds.length === actions.length && actions.every(kind => kinds.includes(kind)));
    const locator = object(params.locator);
    check(locator.type === "object" && locator.additionalProperties === false && locator.minProperties === 1);
    return true;
  } catch { return false; }
}
/** Admit only a native text-free prefix whose acknowledged steps are an exact attempted prefix. */
export function validateDomActionProgress(value: unknown): DomActionProgress {
  const p = object(value);
  fields(p, ["status", "reason", "attempted_steps", "acknowledged_steps", "in_flight", "mutation_attempted", "effects", "automatic_retry", "cleanup"]);
  check(typeof p.status === "string" && ["dispatched", "completed", "refused", "failed", "cancelled", "timeout", "unknown"].includes(p.status) &&
    (p.reason === null || identifier(p.reason, 96)) && p.effects === "unverified" && p.automatic_retry === false &&
    typeof p.cleanup === "string" && ["not_started", "confirmed", "unconfirmed"].includes(p.cleanup));
  const attempted = p.attempted_steps, acknowledged = p.acknowledged_steps;
  check(Array.isArray(attempted) && Array.isArray(acknowledged) && attempted.length <= 32 && acknowledged.length <= attempted.length &&
    attempted.length - acknowledged.length <= 1 && attempted.every(step => steps.has(step)) &&
    acknowledged.every((step, index) => step === attempted[index]) && p.mutation_attempted === (attempted.length > 0) &&
    p.in_flight === (attempted[acknowledged.length] ?? null) && (p.status !== "unknown" || p.in_flight !== null) &&
    (attempted.length === 0 || p.cleanup !== "not_started"));
  return structuredClone(p) as unknown as DomActionProgress;
}
/** Validate closed native receipts before exposing their prefix or treating any refusal as no-effect. */
export function validateDomActionResult(value: unknown): DomActionReceipt {
  check(Buffer.byteLength(JSON.stringify(value) ?? "") <= 16 * 1024);
  const raw = object(value);
  fields(raw, ["format", "status", "input_route", "trusted", "atomic", "native_pixel_mapping", "action_result", "progress", "observed", "refusal", "limitations"]);
  check(raw.format === "dom_action_v1" && typeof raw.status === "string" && ["dispatched", "refused"].includes(raw.status) &&
    (raw.input_route === null || raw.input_route === "dom_event" || raw.input_route === "trusted") && raw.trusted === false && raw.atomic === false && raw.native_pixel_mapping === "unavailable");
  const p = validateDomActionProgress(raw.progress), action = object(raw.action_result);
  fields(action, ["effect", "route", "delivery", "error"], ["effect", "route"]);
  check(action.route === "dom");
  const refusal = raw.refusal === null ? null : object(raw.refusal);
  if (refusal) { fields(refusal, ["code", "message"]); check(identifier(refusal.code, 96) && bounded(refusal.message, 1024)); }
  check(Array.isArray(raw.observed) && raw.observed.length <= p.acknowledged_steps.length);
  for (const [index, value] of raw.observed.entries()) {
    const sample = object(value); fields(sample, ["step", "observed"]);
    check(sample.step === p.acknowledged_steps[index]);
    const observed = object(sample.observed);
    fields(observed, ["activation_invoked", "focused", "scroll_requested", "already_matched", "checked_matches", "value_matches", "text_applied", "selected_matches", "event_cancelled"], []);
    check(Object.values(observed).every(value => typeof value === "boolean"));
  }
  check(JSON.stringify(raw.limitations) === JSON.stringify(["programmatic_dom_semantics_only", "no_css_hover_proof", "no_trusted_key_defaults", "no_application_success_proof"]));
  if (raw.status === "dispatched") check(p.mutation_attempted && p.in_flight === null && p.reason === null && !refusal &&
    ["dispatched", "completed"].includes(p.status) && p.cleanup === "confirmed" && raw.observed.length === p.acknowledged_steps.length);
  else check(!["dispatched", "completed"].includes(p.status) && p.reason !== null && refusal !== null);
  if (p.mutation_attempted) {
    const delivery = object(action.delivery); fields(delivery, ["mode"]);
    check(raw.input_route === "dom_event" && action.effect === "unverifiable" && action.error === undefined && delivery.mode === "unknown");
  } else {
    const error = object(action.error); fields(error, ["code", "hint"]);
    check(refusal && action.effect === "refused" && action.delivery === undefined && error.code === refusal.code && error.hint === refusal.message);
  }
  return structuredClone(raw) as unknown as DomActionReceipt;
}
