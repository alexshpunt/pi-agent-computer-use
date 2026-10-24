import { beforeAll, expect, test } from "vitest";
import { parseLocator } from "../src/native-locator.ts";
import { combine, evaluateNative, validateWait } from "../src/ui-conditions.ts";
import type { UiElement, UiResource } from "../src/ui-resources.ts";

beforeAll(() => { parseLocator("getByRole('button')"); }, 60_000);
const element = (fields: Partial<UiElement>): UiElement => ({ hint: "1:a", element_token: "t", index: 0, parent_hint: null, role: null, name: null, value: null,
  text_truncated: false, enabled: true, selected: null, actions: [], depth: 0, bounds: {}, hint_display: "off", ...fields });
const ui = (elements: UiElement[], complete: boolean | null): UiResource => ({ window_ref: "w", observation_id: "o", snapshot_id: null, captured_at: "",
  complete, truncated: false, truncation_reason: null, native_total: elements.length, collected: elements.length, matches: elements.length, projection_truncated: false, elements });

test("native absence is decided only by a complete walk; a missing element in a partial walk stays unknown", () => {
  const conditions = validateWait({ action: "verify", conditions: [{ target: { role: "Button", name: "Gone" }, is: "absent" }, { target: { text: "Status" }, value: "ok" }] }, false).conditions;
  expect(evaluateNative(ui([], true), conditions).map(r => r.verdict)).toEqual(["satisfied", "unsatisfied"]);
  expect(evaluateNative(ui([], false), conditions).map(r => r.verdict)).toEqual(["unknown", "unknown"]);
  expect(evaluateNative(ui([], null), conditions).map(r => r.verdict)).toEqual(["unknown", "unknown"]);
});

test("native checks compare reported properties and keep ambiguity and missing properties unknown", () => {
  const tree = ui([element({ role: "Button", name: "Save", enabled: false }), element({ role: "Text", name: "Status", value: "saved Ada" }),
    element({ role: "Button", name: "A" }), element({ role: "Button", name: "B" }), element({ role: "Edit", name: "Long", value: "x", text_truncated: true })], true);
  const check = (condition: object) => evaluateNative(tree, validateWait({ action: "verify", conditions: [condition] }, false).conditions)[0];
  expect(check({ target: { role: "Button", name: "Save" }, is: "disabled" }).verdict).toBe("satisfied");
  expect(check({ target: { role: "Button", name: "Save" }, is: "enabled" }).verdict).toBe("unsatisfied");
  expect(check({ target: { text: "Status" }, value: "saved Ada" }).verdict).toBe("satisfied");
  expect(check({ target: "getByText('Status')", contains: "Bob" }).verdict).toBe("unsatisfied");
  expect(check({ target: { role: "Button" }, is: "exists" }).verdict).toBe("unknown");
  expect(check({ target: { role: "button", name: "Save", exact: true }, is: "selected" }).verdict).toBe("unknown");
  // Truncated text cannot prove an exact value either way.
  expect(check({ target: { text: "Long" }, value: "x" }).verdict).toBe("unknown");
});

test("one unsatisfied condition decides; otherwise any unknown keeps the result unknown", () => {
  expect(combine([{ index: 0, verdict: "satisfied" }, { index: 1, verdict: "unknown" }])).toBe("unknown");
  expect(combine([{ index: 0, verdict: "unknown" }, { index: 1, verdict: "unsatisfied" }])).toBe("unsatisfied");
  expect(combine([{ index: 0, verdict: "satisfied" }])).toBe("satisfied");
});

test("wait commands are bounded and reject states the backend cannot report", () => {
  expect(validateWait({ action: "wait_for", conditions: [{ target: { role: "status" }, value: "ok" }] }, true))
    .toMatchObject({ timeout_ms: 5000, interval_ms: 250, stable: 1 });
  expect(validateWait({ action: "verify", conditions: [{ url_contains: "/done" }] }, true)).toMatchObject({ timeout_ms: 0, stable: 1 });
  expect(validateWait({ action: "wait_for", conditions: [{ target: { role: "Document" }, is: "visible" }] }, false).conditions).toHaveLength(1);
  expect(() => validateWait({ action: "wait_for", conditions: [{ target: { css: "div" }, is: "visible" }] }, false)).toThrow(/does not accept css/);
  expect(() => validateWait({ action: "wait_for", conditions: [{ target: { name: "Save" }, is: "visible" }] }, false)).toThrow(/name requires/);
  expect(() => validateWait({ action: "wait_for", conditions: [{ url_contains: "/x" }] }, false)).toThrow(/does not accept: url_contains/);
  expect(() => validateWait({ action: "wait_for", conditions: [{ target: { role: "status" } }] }, true)).toThrow(/needs a target with/);
  expect(() => validateWait({ action: "wait_for", conditions: [{ target: { role: "status" }, value: "a", contains: "b" }] }, true)).toThrow(/one of is, value or contains/);
  expect(() => validateWait({ action: "wait_for", conditions: [{ url_contains: "/x" }], timeout_ms: 120_000 }, true)).toThrow(/timeout_ms/);
  expect(() => validateWait({ action: "verify", conditions: [{ url_contains: "/x" }], stable: 3 }, true)).toThrow(/does not accept: stable/);
});
