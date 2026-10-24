import { createRequire } from "node:module";
import type { UiElement, UiResource } from "./ui-resources.ts";
import type { AriaTreeNode } from "./aria-match.ts";

/** Playwright's own selector and locator parsers; loaded on first use because playwright-core takes about a second to load. */
interface PlaywrightIso {
  unsafeLocatorOrSelectorAsSelector(language: "javascript", locator: string, testIdAttribute: string): string;
  parseSelector(selector: string): ParsedSelector;
  parseAttributeSelector(selector: string, allowUnquotedStrings: boolean): { name: string; attributes: Attribute[] };
  asLocator(language: "javascript", selector: string): string;
  renderAriaSnapshotAsYaml(nodes: AriaNode[]): string;
}
/** The node shape Playwright's aria snapshot renderer takes. */
interface AriaNode {
  role: string; name?: string; text?: string; ref?: string; children?: AriaNode[];
  checked?: boolean | "mixed"; pressed?: boolean | "mixed"; disabled?: boolean; expanded?: boolean; selected?: boolean;
}
let loaded: PlaywrightIso | undefined;
const iso = (): PlaywrightIso => loaded ??= (createRequire(import.meta.url)("playwright-core/lib/coreBundle") as { iso: PlaywrightIso }).iso;

/**
 * Playwright locators over a native UI Automation snapshot.
 *
 * Playwright parses the locator (`getByRole("button", { name: "Save" }).nth(1)`) into its internal selector
 * (`internal:role=button[name="Save"i] >> nth=1`); this module evaluates that selector against the UIA tree
 * with Playwright's semantics: chained parts search inside the previous matches, names and texts match a
 * case-insensitive substring unless exact. UIA reports scrolled-out elements as offscreen; like Playwright, which
 * still finds and scrolls to them, locators match them, and only visible/hidden checks treat them as not visible.
 */

/** A parsed Playwright selector, as `iso.parseSelector` returns it. */
export interface ParsedSelector { parts: { name: string; body: unknown; source: string }[] }
/** The JSON target shared with browser pages; on native windows `ref` is an observation hint and `test_id` an AutomationId. */
export interface NativeTarget {
  ref?: string; role?: string; name?: string; label?: string; text?: string; placeholder?: string; test_id?: string; exact?: boolean;
}

/** UIA control type → ARIA roles, most specific first. The first one names the element in snapshots and suggestions. */
const ROLES: Record<string, string[]> = {
  appbar: ["toolbar"], button: ["button"], calendar: ["grid"], checkbox: ["checkbox"], combobox: ["combobox"], custom: ["generic"],
  datagrid: ["grid", "table"], dataitem: ["row"], document: ["document"], edit: ["textbox"], group: ["group"], header: ["rowgroup"],
  headeritem: ["columnheader"], hyperlink: ["link"], image: ["img"], list: ["list", "listbox"], listitem: ["listitem", "option"],
  menu: ["menu"], menubar: ["menubar"], menuitem: ["menuitem"], pane: ["generic"], progressbar: ["progressbar"], radiobutton: ["radio"],
  scrollbar: ["scrollbar"], semanticzoom: ["generic"], separator: ["separator"], slider: ["slider"], spinner: ["spinbutton"],
  splitbutton: ["button"], statusbar: ["status"], tab: ["tablist"], tabitem: ["tab"], table: ["table", "grid"], text: ["text"],
  thumb: ["generic"], titlebar: ["titlebar"], toolbar: ["toolbar"], tooltip: ["tooltip"], tree: ["tree"], treeitem: ["treeitem"],
  window: ["window", "dialog"],
};
/** Roles Playwright's getByLabel looks at: labelled form controls. */
const LABELLED = new Set(["textbox", "combobox", "checkbox", "radio", "slider", "spinbutton", "listbox", "switch"]);
/** Roles whose `checked` state is a checkbox state; for buttons the same UIA toggle is `pressed`. */
const CHECKABLE = new Set(["checkbox", "radio", "menuitem", "switch", "treeitem", "listitem"]);

/** ARIA roles of a native element, primary first; the UIA control type name also matches. */
export function ariaRoles(element: Pick<UiElement, "role">): string[] {
  const control = (element.role ?? "").replace(/\s+/g, "").toLowerCase();
  return ROLES[control] ?? (control ? [control] : ["generic"]);
}
export const ariaRole = (element: Pick<UiElement, "role">): string => ariaRoles(element)[0];

/** The accessible name: UIA Name when the runtime reports it, otherwise the driver's label. */
export const accessibleName = (element: UiElement): string => element.uia_name ?? element.name ?? "";

/** Checkbox state: the UIA toggle when reported; older runtimes fold it into `selected` for checkable controls. */
export function checkedState(element: UiElement): boolean | "mixed" | null {
  if (element.checked === "on") return true;
  if (element.checked === "off") return false;
  if (element.checked === "mixed") return "mixed";
  return element.checked === undefined && ["checkbox", "radio"].includes(ariaRole(element)) ? element.selected : null;
}
/** Not visible means UIA IsOffscreen (scrolled out, collapsed or minimized); unknown visibility counts as visible. */
export const isVisible = (element: UiElement): boolean => element.offscreen !== true;

const normalize = (value: string) => value.replace(/\s+/g, " ").trim();

/** A Playwright string or regex matcher: `"x"i` substring, `"x"s` exact, `/re/flags`, or an attribute value. */
type Matcher = (value: string) => boolean;
function stringMatcher(value: string | RegExp, exact: boolean): Matcher {
  if (value instanceof RegExp) return text => value.test(normalize(text));
  const wanted = normalize(value);
  return exact ? text => normalize(text) === wanted : text => normalize(text).toLowerCase().includes(wanted.toLowerCase());
}
function textMatcher(body: unknown): Matcher {
  const source = String(body);
  const regex = /^\/(.*)\/([a-z]*)$/s.exec(source);
  if (regex) return stringMatcher(new RegExp(regex[1], regex[2]), false);
  const quoted = /^(".*")([is]?)$/s.exec(source);
  if (!quoted) throw Error(`Unsupported text matcher ${source}.`);
  return stringMatcher(JSON.parse(quoted[1]) as string, quoted[2] === "s");
}
type Attribute = { name: string; op: string; value: unknown; caseSensitive: boolean };
function attributeMatcher(attribute: Attribute): Matcher {
  if (attribute.op !== "=") throw Error(`Attribute operator ${attribute.op} is not supported for native windows.`);
  return stringMatcher(attribute.value as string | RegExp, attribute.caseSensitive);
}
const parseAttributes = (body: unknown): { name: string; attributes: Attribute[] } => iso().parseAttributeSelector(String(body), true);

/** Index, parent links and texts of one snapshot, so selectors evaluate without repeated scans. */
class Tree {
  readonly order = new Map<string, number>();
  readonly byHint = new Map<string, UiElement>();
  constructor(readonly elements: readonly UiElement[]) {
    elements.forEach((element, index) => { this.order.set(element.hint, index); this.byHint.set(element.hint, element); });
  }
  /** Whether `element` lies strictly inside `root`. */
  inside(element: UiElement, root: UiElement): boolean {
    for (let parent = element.parent_hint; parent; parent = this.byHint.get(parent)?.parent_hint ?? null) if (parent === root.hint) return true;
    return false;
  }
  descendants(roots: readonly UiElement[] | null): UiElement[] {
    return roots === null ? [...this.elements] : this.elements.filter(element => roots.some(root => this.inside(element, root)));
  }
  /** Own text plus the text of every descendant, as Playwright's has-text sees an element's text content. */
  subtreeText(element: UiElement): string {
    return [element, ...this.descendants([element])].flatMap(item => [accessibleName(item), item.value ?? ""]).filter(Boolean).join(" ");
  }
  sort(elements: Iterable<UiElement>): UiElement[] {
    return [...new Set(elements)].sort((a, b) => this.order.get(a.hint)! - this.order.get(b.hint)!);
  }
}

/** One query engine: does `element` match this selector part? */
function engine(part: ParsedSelector["parts"][number]): (element: UiElement) => boolean {
  switch (part.name) {
    case "internal:role": case "role": {
      const { name: role, attributes } = parseAttributes(part.body);
      const wanted = role.toLowerCase();
      const checks: ((element: UiElement) => boolean)[] = [element => ariaRoles(element).includes(wanted) || (element.role ?? "").toLowerCase() === wanted];
      for (const attribute of attributes) {
        const value = attribute.value;
        switch (attribute.name) {
          case "name": { const match = attributeMatcher(attribute); checks.push(element => match(accessibleName(element))); break; }
          case "include-hidden": break;
          case "checked": checks.push(element => CHECKABLE.has(ariaRole(element)) && String(checkedState(element)) === String(value)); break;
          case "pressed": checks.push(element => ariaRole(element) === "button" && element.checked !== undefined && String(checkedState({ ...element, role: "CheckBox" })) === String(value)); break;
          case "disabled": checks.push(element => element.enabled !== null && String(element.enabled === false) === String(value)); break;
          case "selected": checks.push(element => element.selected !== null && String(element.selected) === String(value)); break;
          case "expanded": checks.push(element => element.expanded !== undefined && String(element.expanded) === String(value)); break;
          default: throw Error(`getByRole option ${attribute.name} is not available for native windows.`);
        }
      }
      return element => checks.every(check => check(element));
    }
    case "internal:text": { const match = textMatcher(part.body); return element => match(accessibleName(element)) || (ariaRole(element) === "text" && match(element.value ?? "")); }
    case "internal:label": { const match = textMatcher(part.body); return element => LABELLED.has(ariaRole(element)) && match(accessibleName(element)); }
    case "internal:testid": {
      const [attribute] = parseAttributes(part.body).attributes;
      const match = attributeMatcher(attribute);
      return element => element.automation_id !== undefined && match(element.automation_id);
    }
    case "internal:attr": {
      const [attribute] = parseAttributes(part.body).attributes;
      const match = attributeMatcher(attribute);
      if (attribute.name === "title" || attribute.name === "placeholder") return element => element.help_text !== undefined && match(element.help_text);
      if (attribute.name === "alt") return element => ariaRole(element) === "img" && match(accessibleName(element));
      throw Error(`Attribute ${attribute.name} is not available for native windows.`);
    }
    default:
      throw Error(`Selector engine "${part.name}" is not available for native windows. Use getByRole, getByText, getByLabel, getByTestId (AutomationId), getByTitle, filter, nth, and or or.`);
  }
}
const nested = (body: unknown): ParsedSelector => {
  const parsed = (body as { parsed?: ParsedSelector })?.parsed;
  if (!parsed) throw Error("A nested locator could not be read.");
  return parsed;
};

/** Evaluate a parsed selector from `roots` (the whole window when null) in tree order. */
function evaluate(tree: Tree, selector: ParsedSelector, roots: readonly UiElement[] | null): UiElement[] {
  let current: UiElement[] | null = null;
  let scope = roots;
  for (const part of selector.parts) {
    const all = () => current ?? tree.descendants(scope);
    switch (part.name) {
      case "nth": {
        const index = Number(part.body), list = all();
        const item = index < 0 ? list[list.length + index] : list[index];
        current = item ? [item] : [];
        break;
      }
      case "visible": current = all().filter(element => isVisible(element) === (String(part.body) === "true")); break;
      case "internal:has-text": case "internal:has-not-text": {
        const match = textMatcher(part.body), keep = part.name === "internal:has-text";
        current = all().filter(element => match(tree.subtreeText(element)) === keep);
        break;
      }
      case "internal:has": case "internal:has-not": {
        const inner = nested(part.body), keep = part.name === "internal:has";
        current = all().filter(element => (evaluate(tree, inner, [element]).length > 0) === keep);
        break;
      }
      case "internal:and": { const other = new Set(evaluate(tree, nested(part.body), scope)); current = all().filter(element => other.has(element)); break; }
      case "internal:or": current = tree.sort([...all(), ...evaluate(tree, nested(part.body), scope)]); break;
      case "internal:describe": break;
      default: {
        const match = engine(part);
        scope = current ?? roots;
        current = tree.descendants(scope).filter(match);
      }
    }
  }
  return current ?? tree.descendants(roots);
}

/** Playwright's internal selector for a JSON target, in the same shape browser pages use. */
export function targetSelector(target: NativeTarget): string {
  const quote = (value: string, exact: boolean) => `${JSON.stringify(value)}${exact ? "s" : "i"}`;
  const exact = target.exact === true;
  const parts: string[] = [];
  if (target.role !== undefined) parts.push(`internal:role=${target.role}${target.name !== undefined ? `[name=${quote(target.name, exact)}]` : ""}`);
  if (target.label !== undefined) parts.push(`internal:label=${quote(target.label, exact)}`);
  if (target.text !== undefined) parts.push(`internal:text=${quote(target.text, exact)}`);
  if (target.placeholder !== undefined) parts.push(`internal:attr=[placeholder=${quote(target.placeholder, exact)}]`);
  if (target.test_id !== undefined) parts.push(`internal:testid=[data-testid=${quote(target.test_id, true)}]`);
  if (!parts.length) throw Error("target needs role, label, text, placeholder or test_id.");
  return parts.slice(1).reduce((all, part) => `${all} >> internal:and=${JSON.stringify(part)}`, parts[0]);
}

/** Playwright's internal selector for a locator such as `getByRole("button", { name: "Save" }).nth(1)`. */
export function locatorSelector(locator: string): string {
  if (typeof locator !== "string" || !locator.trim() || locator.length > 2000) throw Error("A locator must be a Playwright locator string of at most 2000 characters.");
  try { return iso().unsafeLocatorOrSelectorAsSelector("javascript", locator.trim().replace(/^(?:page|window|this)\./, ""), "data-testid"); }
  catch (error) { throw Error(`The locator could not be parsed: ${error instanceof Error ? error.message : String(error)}`); }
}

/** Parse a Playwright locator for a native window. CSS and XPath parse here but refuse when evaluated. */
export function parseLocator(locator: string): ParsedSelector {
  return iso().parseSelector(locatorSelector(locator));
}

const TARGET_FIELDS = ["role", "name", "label", "text", "placeholder", "test_id", "exact"] as const;
/**
 * A native target: a Playwright locator string, or the JSON target browser pages take. Hints are snapshot-local,
 * so `ref` refuses here: targets resolve in fresh UI walks.
 */
export function nativeSelector(value: unknown, what = "target"): ParsedSelector {
  if (typeof value === "string") return parseLocator(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error(`${what} must be a Playwright locator string or an object with ${TARGET_FIELDS.join(", ")}.`);
  const target = value as Record<string, unknown>;
  if ("ref" in target) throw Error(`${what}.ref names an element of one observation; use a hint in the observation address, or a locator.`);
  const extra = Object.keys(target).filter(key => !(TARGET_FIELDS as readonly string[]).includes(key));
  if (extra.length) throw Error(`${what} does not accept ${extra.join(", ")}; use ${TARGET_FIELDS.join(", ")} or a locator string.`);
  for (const key of TARGET_FIELDS) if (key !== "exact" && target[key] !== undefined && (typeof target[key] !== "string" || !target[key] || (target[key] as string).length > 512))
    throw Error(`${what}.${key} must be a non-empty string of at most 512 characters.`);
  if (target.exact !== undefined && typeof target.exact !== "boolean") throw Error(`${what}.exact must be boolean.`);
  if (target.name !== undefined && target.role === undefined) throw Error(`${what}.name requires ${what}.role.`);
  return iso().parseSelector(targetSelector(target as NativeTarget));
}

/** Elements of one snapshot that a parsed selector matches, in tree order. */
export function queryNative(ui: Pick<UiResource, "elements">, selector: ParsedSelector): UiElement[] {
  return evaluate(new Tree(ui.elements), selector, null);
}

/**
 * The UIA tree as a Playwright aria snapshot, rendered by Playwright itself: `- button "Save" [ref=g:a]`,
 * `- textbox "Name": Ada`, `- checkbox "Agree" [checked]`, nested children, `- text: idle`. Refs are observation hints.
 */
export function nativeAriaSnapshot(ui: Pick<UiResource, "elements">, root?: UiElement): string {
  const { roots, nodes } = ariaNodes(ui);
  return iso().renderAriaSnapshotAsYaml(root ? [nodes.get(root.hint)!] : roots);
}

/** The tree toMatchAriaSnapshot checks: a fragment of the whole window, or of one element and its subtree. */
export function nativeAriaTree(ui: Pick<UiResource, "elements">, root?: UiElement): AriaTreeNode {
  const { roots, nodes } = ariaNodes(ui);
  const convert = (node: AriaNode): AriaTreeNode | string => node.role === "text" ? normalize(node.text ?? "") : {
    ...node, children: [...(node.text !== undefined ? [normalize(node.text)] : []), ...(node.children ?? []).map(convert)],
  };
  return { role: "fragment", children: (root ? [nodes.get(root.hint)!] : roots).map(convert) };
}

function ariaNodes(ui: Pick<UiResource, "elements">): { roots: AriaNode[]; nodes: Map<string, AriaNode> } {
  const nodes = new Map<string, AriaNode>(), roots: AriaNode[] = [];
  for (const element of ui.elements) {
    const role = ariaRole(element), name = accessibleName(element);
    if (role === "text") { nodes.set(element.hint, { role, text: name || element.value || "" }); continue; }
    const node: AriaNode = { role, ref: element.hint, ...(name ? { name } : {}) };
    if (role === "textbox" || role === "combobox" || role === "spinbutton" || role === "slider") { if (element.value) node.text = element.value; }
    const state = checkedState(element);
    if (state !== null) { if (role === "button") node.pressed = state; else node.checked = state; }
    if (element.enabled === false) node.disabled = true;
    if (element.expanded === true) node.expanded = true;
    if (element.selected === true && state === null) node.selected = true;
    nodes.set(element.hint, node);
  }
  for (const element of ui.elements) {
    const node = nodes.get(element.hint)!, parent = element.parent_hint ? nodes.get(element.parent_hint) : undefined;
    if (parent && parent.role !== "text") (parent.children ??= []).push(node); else roots.push(node);
  }
  return { roots, nodes };
}

/** A Playwright locator that names this element, for strict-mode errors and listings. */
export function suggestLocator(element: UiElement): string {
  const role = ariaRole(element), name = accessibleName(element);
  if (element.automation_id && !/^\d+$/.test(element.automation_id)) return `getByTestId(${JSON.stringify(element.automation_id)})`;
  return iso().asLocator("javascript", `internal:role=${role}${name ? `[name=${JSON.stringify(name)}s]` : ""}`);
}
