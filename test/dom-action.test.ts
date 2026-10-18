import { expect, test } from "vitest";
import { validateDomActionCommand, validateDomActionResult } from "../src/dom-action.ts";

function receipt() {
  return { format: "dom_action_v1", status: "refused", input_route: "dom_event", trusted: false, atomic: false,
    native_pixel_mapping: "unavailable", action_result: { effect: "unverifiable", route: "dom", delivery: { mode: "unknown" } },
    progress: { status: "unknown", reason: "dom_action_dispatch_refused", attempted_steps: ["click", "dblclick"],
      acknowledged_steps: ["click"], in_flight: "dblclick", mutation_attempted: true, effects: "unverified", automatic_retry: false, cleanup: "confirmed" },
    observed: [{ step: "click", observed: { activation_invoked: true } }],
    refusal: { code: "browser_route_unavailable", message: "Native reply unavailable" },
    limitations: ["programmatic_dom_semantics_only", "no_css_hover_proof", "no_trusted_key_defaults", "no_application_success_proof"] };
}

test("enum-shaped arrays are rejected rather than coerced to command or receipt strings", () => {
  const command = { action: "dom", source_hint: "1:a", input_route: ["dom_event"], request: { action: "click", locator: { css: "button" } } };
  expect(() => validateDomActionCommand(command)).toThrow(/dom_action_invalid_request/);
  for (const change of [
    (v: any) => { v.status = ["refused"]; },
    (v: any) => { v.progress.status = ["unknown"]; },
    (v: any) => { v.progress.cleanup = ["confirmed"]; },
  ]) {
    const value = receipt(); change(value);
    expect(() => validateDomActionResult(value)).toThrow(/invalid_dom_action_result/);
  }
});
test("an interrupted DOM action keeps its acknowledged prefix and unknown last step", () => {
  const value = receipt();
  expect(validateDomActionResult(value)).toEqual(value);
});
test("dispatch is unverified even when every step is acknowledged", () => {
  const value = receipt();
  Object.assign(value, { status: "dispatched", refusal: null });
  Object.assign(value.progress, { status: "dispatched", reason: null, attempted_steps: ["click"], in_flight: null });
  expect(validateDomActionResult(value)).toEqual(value);
  value.action_result.effect = "confirmed";
  expect(() => validateDomActionResult(value)).toThrow(/invalid_dom_action_result/);
});
test("invalid or leaking native receipts cannot become accepted effects", () => {
  const mutations = [
    (v: any) => { v.backendNodeId = 42; },
    (v: any) => { v.progress.acknowledged_steps = ["other"]; },
    (v: any) => { v.progress.in_flight = null; },
    (v: any) => { v.progress.automatic_retry = true; },
    (v: any) => { v.trusted = true; },
    (v: any) => { v.observed[0].observed.value = "private input"; },
    (v: any) => { v.refusal.message = "😀".repeat(300); },
    (v: any) => { v.limitations = []; },
  ];
  for (const change of mutations) {
    const value = receipt(); change(value);
    expect(() => validateDomActionResult(value)).toThrow(/invalid_dom_action_result/);
  }
});
