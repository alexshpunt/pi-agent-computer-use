import { beforeAll, expect, test } from "vitest";
import { ariaRole, nativeAriaSnapshot, parseLocator, queryNative, suggestLocator, targetSelector } from "../src/native-locator.ts";
import type { UiElement, UiResource } from "../src/ui-resources.ts";
import { evaluateNative, validateWait } from "../src/ui-conditions.ts";

/** The WinForms fixture of the live checks, as a runtime with the full UIA tree reports it. */
function element(hint: string, role: string, name: string, extra: Partial<UiElement> = {}): UiElement {
  return { hint, element_token: `s1:${hint}`, index: null, parent_hint: "w", role, name, value: null, text_truncated: false,
    enabled: true, selected: null, actions: [], depth: 1, bounds: {}, hint_display: "off", uia_name: name, ...extra };
}
const tree = { elements: [
  element("w", "Window", "Fixture", { parent_hint: null, depth: 0 }),
  element("count", "Button", "Count 0", { automation_id: "countButton" }),
  element("off", "Button", "Disabled", { enabled: false }),
  element("name", "Edit", "Name", { value: "Ada Lovelace" }),
  element("agree", "CheckBox", "Agree", { checked: "on" }),
  element("opts", "Group", "Options"),
  element("ok", "Button", "OK", { parent_hint: "opts", depth: 2 }),
  element("pick", "List", "Pick"),
  element("alpha", "ListItem", "alpha", { parent_hint: "pick", depth: 2, selected: false }),
  element("beta", "ListItem", "beta", { parent_hint: "pick", depth: 2, selected: true }),
  element("hidden", "ListItem", "gamma", { parent_hint: "pick", depth: 2, offscreen: true }),
  element("status", "Text", "clicked 3"),
  element("save", "Button", "Save", { help_text: "Save the file" }),
  element("saveAs", "Button", "Save as…"),
  // WinForms names a MenuStrip after the label before it; that name is a label, not text content.
  element("bar", "MenuBar", "clicked 3"),
  element("file", "MenuItem", "File", { parent_hint: "bar", depth: 2 }),
] };
// playwright-core loads on first use; under a parallel test run that can take several seconds.
beforeAll(() => { parseLocator("getByRole('button')"); }, 60_000);
const hints = (locator: string) => queryNative(tree, parseLocator(locator)).map(found => found.hint);

test("getByRole matches ARIA or UIA roles and names the Playwright way: substring by default, exact on request", () => {
  expect(hints(`getByRole("button", { name: "Count 0" })`)).toEqual(["count"]);
  expect(hints(`getByRole("Button", { name: "count" })`)).toEqual(["count"]);
  expect(hints(`getByRole("button", { name: "Save" })`)).toEqual(["save", "saveAs"]);
  expect(hints(`getByRole("button", { name: "Save", exact: true })`)).toEqual(["save"]);
  expect(hints(`getByRole("button", { name: /^save$/i })`)).toEqual(["save"]);
  expect(hints(`getByRole("textbox")`)).toEqual(["name"]);
  expect(hints(`getByRole("option")`)).toEqual(["alpha", "beta", "hidden"]);
});

test("role states filter like Playwright's options; scrolled-out elements still match, and visible filters them", () => {
  expect(hints(`getByRole("checkbox", { checked: true })`)).toEqual(["agree"]);
  expect(hints(`getByRole("checkbox", { checked: false })`)).toEqual([]);
  expect(hints(`getByRole("button", { disabled: true })`)).toEqual(["off"]);
  expect(hints(`getByRole("listitem", { selected: true })`)).toEqual(["beta"]);
  expect(hints(`getByRole("listitem", { includeHidden: true })`)).toEqual(["alpha", "beta", "hidden"]);
  expect(hints(`getByRole("listitem").filter({ visible: true })`)).toEqual(["alpha", "beta"]);
  expect(() => hints(`getByRole("heading", { level: 2 })`)).toThrow(/level is not available for native windows/);
});

test("text, label, test id and title locators read the matching UIA properties", () => {
  expect(hints(`getByText("clicked")`)).toEqual(["status"]);
  // Like Playwright: the smallest element whose text content matches, so a group matches by its caption and items by their own text.
  expect(hints(`getByText("Options")`)).toEqual(["opts"]);
  expect(hints(`getByText("OK")`)).toEqual(["ok"]);
  expect(hints(`getByText("File")`)).toEqual(["file"]);
  expect(hints(`getByRole("menubar").filter({ hasText: "File" })`)).toEqual(["bar"]);
  expect(hints(`getByRole("menubar").filter({ hasText: "clicked" })`)).toEqual([]);
  expect(hints(`getByText("Clicked 3", { exact: true })`)).toEqual([]);
  expect(hints(`getByText("clicked 3", { exact: true })`)).toEqual(["status"]);
  expect(hints(`getByLabel("Name")`)).toEqual(["name"]);
  expect(hints(`getByLabel("Agree")`)).toEqual(["agree"]);
  expect(hints(`getByTestId("countButton")`)).toEqual(["count"]);
  expect(hints(`getByTitle("Save the file")`)).toEqual(["save"]);
});

test("chaining searches inside the previous matches; filter, nth, and, or compose", () => {
  expect(hints(`getByRole("group", { name: "Options" }).getByRole("button")`)).toEqual(["ok"]);
  expect(hints(`getByRole("list").getByRole("listitem").filter({ hasText: "beta" })`)).toEqual(["beta"]);
  expect(hints(`getByRole("listitem").filter({ hasNotText: "beta" })`)).toEqual(["alpha", "hidden"]);
  expect(hints(`getByRole("group").filter({ has: getByRole("button", { name: "OK" }) })`)).toEqual(["opts"]);
  expect(hints(`getByRole("list").filter({ hasText: "beta" })`)).toEqual(["pick"]);
  expect(hints(`getByRole("button").first()`)).toEqual(["count"]);
  expect(hints(`getByRole("button").last()`)).toEqual(["saveAs"]);
  expect(hints(`getByRole("button").nth(2)`)).toEqual(["ok"]);
  expect(hints(`getByRole("button").and(getByTitle("Save the file"))`)).toEqual(["save"]);
  expect(hints(`getByRole("checkbox").or(getByRole("textbox"))`)).toEqual(["name", "agree"]);
  expect(hints(`page.getByRole("button", { name: "OK" })`)).toEqual(["ok"]);
});

test("CSS, XPath and unparsable locators refuse instead of guessing", () => {
  expect(() => hints(`locator("css=div")`)).toThrow(/not available for native windows/);
  expect(() => hints(`locator("//div")`)).toThrow(/not available for native windows/);
  expect(() => hints(`getByRole(`)).toThrow(/could not be parsed/);
});

test("the JSON target shared with browser pages becomes the same Playwright selector", () => {
  const byTarget = (target: Parameters<typeof targetSelector>[0]) => queryNative(tree, parseLocator(targetSelector(target))).map(found => found.hint);
  expect(byTarget({ role: "button", name: "Save" })).toEqual(["save", "saveAs"]);
  expect(byTarget({ role: "button", name: "Save", exact: true })).toEqual(["save"]);
  expect(byTarget({ role: "textbox", label: "Name" })).toEqual(["name"]);
  expect(byTarget({ text: "clicked" })).toEqual(["status"]);
  expect(byTarget({ test_id: "countButton" })).toEqual(["count"]);
  expect(() => targetSelector({})).toThrow(/needs role/);
});

test("a native window renders as Playwright's own aria snapshot, with hints as refs", () => {
  expect(nativeAriaSnapshot(tree)).toBe([
    `- window "Fixture" [ref=w]:`,
    `  - button "Count 0" [ref=count]`,
    `  - button "Disabled" [disabled] [ref=off]`,
    `  - textbox "Name" [ref=name]: Ada Lovelace`,
    `  - checkbox "Agree" [checked] [ref=agree]`,
    `  - group "Options" [ref=opts]:`,
    `    - button "OK" [ref=ok]`,
    `  - list "Pick" [ref=pick]:`,
    `    - listitem "alpha" [ref=alpha]`,
    `    - listitem "beta" [selected] [ref=beta]`,
    `    - listitem "gamma" [ref=hidden]`,
    `  - text: clicked 3`,
    `  - button "Save" [ref=save]`,
    `  - button "Save as…" [ref=saveAs]`,
    `  - menubar "clicked 3" [ref=bar]:`,
    `    - menuitem "File" [ref=file]`,
  ].join("\n"));
});

test("suggested locators name an element with Playwright syntax", () => {
  const byHint = (hint: string) => tree.elements.find(found => found.hint === hint)!;
  expect(suggestLocator(byHint("count"))).toBe(`getByTestId("countButton")`);
  expect(suggestLocator(byHint("ok"))).toBe(`getByRole('button', { name: 'OK', exact: true })`);
  expect(ariaRole(byHint("name"))).toBe("textbox");
  // Older runtimes fold the checkbox toggle into `selected`.
  const old = { elements: [element("c", "CheckBox", "Agree", { uia_name: undefined, selected: true })] };
  expect(queryNative(old, parseLocator(`getByRole("checkbox", { name: "Agree", checked: true })`)).length).toBe(1);
});

test("count and aria conditions follow toHaveCount and toMatchAriaSnapshot, proving mismatches only in complete walks", () => {
  const ui = (complete: boolean) => ({ ...tree, collected: tree.elements.length, complete, truncated: false }) as unknown as UiResource;
  const verdicts = (conditions: Record<string, unknown>[], complete = true) =>
    evaluateNative(ui(complete), validateWait({ action: "verify", conditions }, false).conditions).map(result => result.verdict);
  expect(verdicts([
    { target: `getByRole("listitem")`, count: 3 },
    { target: `getByRole("listitem")`, count: 2 },
    { aria: `- list "Pick":\n  - listitem "beta" [selected]` },
    { aria: `- textbox "Name": Ada Lovelace` },
    { aria: `- button /Count \\d+/` },
    { target: `getByRole("group", { name: "Options" })`, aria: `- group:\n  - button "OK"` },
    { target: `getByRole("group", { name: "Options" })`, aria: `- button "Save"` },
    { aria: `- checkbox "Agree" [checked=false]` },
  ])).toEqual(["satisfied", "unsatisfied", "satisfied", "satisfied", "satisfied", "satisfied", "unsatisfied", "unsatisfied"]);
  expect(verdicts([{ target: `getByRole("listitem")`, count: 3 }, { aria: `- button "Nope"` }, { target: `getByRole("listitem")`, count: 1 }], false))
    .toEqual(["unknown", "unknown", "unsatisfied"]);
  const [miss] = evaluateNative(ui(true), validateWait({ action: "verify", conditions: [{ aria: `- button "Nope"` }] }, false).conditions);
  expect(miss.observed).toContain(`- button "Count 0" [ref=count]`);
  expect(() => validateWait({ action: "verify", conditions: [{ aria: "- button [" }] }, false)).toThrow(/not a valid aria snapshot/);
  expect(() => validateWait({ action: "verify", conditions: [{ count: 1 }] }, false)).toThrow(/needs a target/);
});
