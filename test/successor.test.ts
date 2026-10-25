import { expect, test } from "vitest";
import { diffDom, diffUi } from "../src/successor.ts";
import { evaluateNative, validateWait } from "../src/ui-conditions.ts";
import type { WebDom } from "../src/session.ts";
import type { UiElement, UiResource } from "../src/ui-resources.ts";

const dom = (snapshot: string, extra: Partial<WebDom> = {}): WebDom =>
  ({ url: "http://x/a", title: "A", snapshot, tabs: [], active: "t1", events: [], truncated: false, ...extra });
const element = (fields: Partial<UiElement>): UiElement => ({ hint: "1:a", element_token: "t", index: 0, parent_hint: null, role: null, name: null, value: null,
  text_truncated: false, enabled: true, selected: null, actions: [], depth: 0, bounds: {}, hint_display: "off", ...fields });
const ui = (elements: UiElement[], complete = true): UiResource => ({ window_ref: "w", observation_id: "o", snapshot_id: null, captured_at: "",
  complete, truncated: false, truncation_reason: null, native_total: elements.length, collected: elements.length, matches: elements.length, projection_truncated: false, elements });

test("a DOM diff ignores renumbered refs and pairs an element's changed value or state into one change", () => {
  const before = dom('- heading "Wait" [ref=e1]\n- textbox "Name" [ref=e4]\n- status [ref=e9]: idle\n- button "Go" [ref=e7]');
  const after = dom('- heading "Wait" [ref=e2]\n- textbox "Name" [active] [ref=e5]: Ada\n- status [ref=e9]: saved Ada\n- alert [ref=e10]: Done', { url: "http://x/b" });
  const diff = diffDom(before, after);
  expect(diff.changed).toEqual([
    '- textbox "Name" [ref=e4] → - textbox "Name" [active] [ref=e5]: Ada',
    "- status [ref=e9]: idle → - status [ref=e9]: saved Ada",
  ]);
  expect(diff.added).toEqual(["- alert [ref=e10]: Done"]);
  expect(diff.removed).toEqual(['- button "Go" [ref=e7]']);
  expect(diff.page).toEqual({ url: ["http://x/a", "http://x/b"] });
});

test("an unchanged page has an empty diff, so no change is distinguishable from an asynchronous result", () => {
  const snapshot = '- status [ref=e1]: saving';
  expect(diffDom(dom(snapshot), dom(snapshot)).counts).toEqual({ changed: 0, added: 0, removed: 0 });
});

test("a native diff matches by role and name, pairs a renamed control by its place and flags walks that cannot prove removal", () => {
  const before = ui([element({ hint: "1:a", role: "Document", name: "Text", value: "a b" }), element({ hint: "1:b", role: "Button", name: "Count 0" }),
    element({ hint: "1:c", role: "CheckBox", name: "Agree", checked: "off" }), element({ hint: "1:d", role: "Text", name: "Saving…" })]);
  const after = ui([element({ hint: "2:a", role: "Document", name: "Text", value: "ab" }), element({ hint: "2:b", role: "Button", name: "Count 1" }),
    element({ hint: "2:c", role: "CheckBox", name: "Agree", checked: "on" }), element({ hint: "2:d", role: "Text", name: "Saved" }), element({ hint: "2:e", role: "Button", name: "Undo" })], false);
  const diff = diffUi(before, after);
  // The text kept its place too, so it reads as a change; the new Undo button has no counterpart.
  expect(diff.counts).toEqual({ changed: 4, added: 1, removed: 0 });
  expect(diff.changed).toEqual([
    '2:a Document "Text": value="a b" → "ab"',
    '2:c CheckBox "Agree": checked=off → on',
    '2:b Button "Count 0" → "Count 1"',
    '2:d Text "Saving…" → "Saved"',
  ]);
  expect(diff.added).toEqual(['2:e Button "Undo" value=null enabled=true selected=null']);
  expect(diff.note).toMatch(/partial/);
  // A control that disappeared with nothing in its place is a removal.
  expect(diffUi(after, ui([after.elements[0]])).removed).toHaveLength(4);
});

test("native text checks use the full text kept by the capture instead of the walk's 1024-character cut", () => {
  const tree = ui([element({ hint: "1:a", role: "Document", value: "x".repeat(1024), text_truncated: true })]);
  const conditions = validateWait({ action: "verify", conditions: [{ target: { role: "Document" }, contains: "TAIL" }] }, false).conditions;
  expect(evaluateNative(tree, conditions)[0].verdict).toBe("unknown");
  expect(evaluateNative(tree, conditions, new Map([["1:a", "x".repeat(1100) + "TAIL"]]))[0].verdict).toBe("satisfied");
});
