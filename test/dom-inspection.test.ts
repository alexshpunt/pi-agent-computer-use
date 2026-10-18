import { expect, test } from "vitest";
import { validateDomRead, validateDomSnapshot } from "../src/dom-inspection.ts";
import { validateDomBinding } from "../src/dom-inspection.ts";
import { createDomResource, domPreview, projectDom } from "../src/dom-resource.ts";

const binding = { target_id: "owned-target", tab_id: "owned-tab" };
const boundWindow = () => ({ status: "ok", mode: "bind", binding_quality: "exact", endpoint_access_class: "driver_owned",
  target_id: binding.target_id, tabs: [{ tab_id: binding.tab_id, active: true, title: "Synthetic DOM", url: "http://127.0.0.1:4100/" }] });

test("readonly DOM admission requires one selected tab in an exact driver-owned window", () => {
  expect(validateDomBinding(boundWindow())).toEqual(binding);
  const inactive = { ...boundWindow().tabs[0], tab_id: "other-tab", active: false };
  expect(validateDomBinding({ ...boundWindow(), tabs: [inactive, ...boundWindow().tabs] })).toEqual(binding);
  for (const change of [
    (value: any) => value.binding_quality = "heuristic",
    (value: any) => value.endpoint_access_class = "existing_profile",
    (value: any) => value.tabs[0].active = false,
    (value: any) => value.tabs.push({ ...value.tabs[0], tab_id: "ambiguous" }),
    (value: any) => value.tabs.push({ ...value.tabs[0], active: false }),
    (value: any) => value.target_id = "",
    (value: any) => value.tabs[0].url = 12,
    (value: any) => value.status = "refused",
  ]) { const value = boundWindow(); change(value); expect(() => validateDomBinding(value)).toThrow(); }
});

test("refreshing window metadata never silently replaces the admitted DOM tab or target", () => {
  expect(validateDomBinding(boundWindow(), binding)).toEqual(binding);
  expect(() => validateDomBinding({ ...boundWindow(), target_id: "replacement" }, binding)).toThrow();
  const selected = boundWindow(); selected.tabs[0].tab_id = "new-selected-tab";
  expect(() => validateDomBinding(selected, binding)).toThrow();
});
const element = (ref: string) => ({ ref, frame: { ref: "opaque-frame", kind: "main" }, tag: "button",
  attributes: { "data-testid": "choice" }, text: "Choice", text_truncated: false, role: "button", name: "Choice", value: null,
  states: { enabled: true }, visibility: "visible", bounds_css: { x: 20, y: 40, width: 100, height: 30 }, coordinate_space: "document_css_pixels" });
const native = () => ({ status: "ok", mode: "snapshot", ...binding, page: { url: "http://127.0.0.1:4100/", title: "Synthetic DOM" },
  snapshot: { id: "p1", format: "dom_inspect_v1", complete: true, collection_complete: true, matched_count: 2,
    returned_count: 2, truncated: false, omitted: { nodes: 0, depth: 0, frames: 0, metadata: 0, text: 0, hidden_filtered: 0 }, scope: "document" }, elements: [element("p1:0"), element("p1:1")] });

test("DOM options preserve exact locators and refuse injected browser identity or unsupported budgets", () => {
  expect(validateDomRead({ locator: { role: "button", name: "Choice", css: "button[data-testid=choice]" } })).toEqual({
    locator: { role: "button", name: "Choice", css: "button[data-testid=choice]" } });
  for (const input of [{ target_id: "foreign" }, { scope_ref: "p1:0" }, { scope: "p1:0" }, { locator: { script: "x" } },
    { locator: { css: "" } }, { locator: { text: "x".repeat(257) } }, { max_nodes: 0 }, { max_depth: 33 }, { include_hidden: 1 }])
    expect(() => validateDomRead(input)).toThrow();
});
test("exact source DOM keeps duplicate labels and CSS bounds without creating action authority", () => {
  const result = validateDomSnapshot(native(), binding, 100);
  expect(result.elements.map(row => row.ref)).toEqual(["p1:0", "p1:1"]);
  expect(result.elements[0].coordinate_space).toBe("document_css_pixels");
  expect(result.complete).toBe(true);
  expect(result.page.url).toBe("http://127.0.0.1:4100/");
});
test("partial traversal cannot be laundered into definitive absence", () => {
  const value = native(); value.elements = []; value.snapshot.returned_count = value.snapshot.matched_count = 0;
  value.snapshot.complete = false; value.snapshot.collection_complete = false; value.snapshot.omitted.depth = 3;
  expect(validateDomSnapshot(value, binding, 100).complete).toBe(false);
  value.snapshot.complete = true;
  expect(() => validateDomSnapshot(value, binding, 100)).toThrow();
});
test("native reference syntax and coverage keys cannot be replaced with guessed authority or completeness", () => {
  for (const ref of ["p1:", "p1:scope", "p1:0:child", "p1:-1", "p2:0"]) {
    const value = native(); value.elements[0].ref = ref;
    expect(() => validateDomSnapshot(value, binding, 100)).toThrow();
  }
  const missing = native(); Reflect.deleteProperty(missing.snapshot.omitted, "frames");
  expect(() => validateDomSnapshot(missing, binding, 100)).toThrow();
  const failedMetadata = native(); failedMetadata.snapshot.omitted.metadata = 1;
  expect(() => validateDomSnapshot(failedMetadata, binding, 100)).toThrow();
  failedMetadata.snapshot.complete = failedMetadata.snapshot.collection_complete = false;
  expect(validateDomSnapshot(failedMetadata, binding, 100).complete).toBe(false);
  const failedText = native(); failedText.snapshot.omitted.text = 1;
  expect(() => validateDomSnapshot(failedText, binding, 100)).toThrow();
  const unknownOmission = native(); Object.assign(unknownOmission.snapshot.omitted, { inaccessible_sources: 1 });
  expect(() => validateDomSnapshot(unknownOmission, binding, 100)).toThrow();
  const guessedVisibility = native(); guessedVisibility.elements[0].visibility = "in_viewport";
  expect(() => validateDomSnapshot(guessedVisibility, binding, 100)).toThrow();
});
test("foreign tabs, malformed frame records, duplicate refs, oversized data and input claims refuse", () => {
  const changes = [
    (value: any) => value.tab_id = "foreign",
    (value: any) => value.elements[1].ref = value.elements[0].ref,
    (value: any) => value.elements[0].frame.kind = "unknown",
    (value: any) => value.elements[0].coordinate_space = "windows_desktop_pixels",
    (value: any) => value.elements[0].bounds_css.width = -1,
    (value: any) => value.elements[0].attributes.title = "x".repeat(1025),
    (value: any) => value.elements[0].actions = ["click"],
    (value: any) => value.snapshot.returned_count = 1,
    (value: any) => value.snapshot.omitted.depth = -1,
  ];
  for (const change of changes) { const value = native(); change(value); expect(() => validateDomSnapshot(value, binding, 100)).toThrow(); }
  expect(() => validateDomSnapshot(native(), binding, 1)).toThrow();
});

const authorCoverage = () => ({ collection_scope: "author_dom_with_open_shadow", excluded: {
  user_agent_shadow_roots: 5, user_agent_shadow_hosts: { input: 1, select: 1, option: 3, textarea: 0, button: 0, other: 0 },
} });
const authorNative = () => { const value = native(); return { ...value, snapshot: { ...value.snapshot, ...authorCoverage() } }; };

test("authored DOM coverage retains browser-internal exclusions through cached projections", () => {
  const snapshot = validateDomSnapshot(authorNative(), binding, 100);
  expect(snapshot).toMatchObject(authorCoverage());
  // Native layout coordinates remain withheld independently of the collection scope.
  snapshot.elements.forEach(row => { row.bounds_css = null; });
  const resource = createDomResource(snapshot, binding, "owned-window", "owned-observation", 1).resource;
  expect(resource).toMatchObject({ ...authorCoverage(), complete: true, collection_complete: true });
  const projected = projectDom(resource, { operation: "search", query: "Choice", limit: 1 });
  expect(projected).toMatchObject({ ...authorCoverage(), matches: 2, projection_truncated: true });
  expect(domPreview(projected)).toMatchObject(authorCoverage());
});

test("legacy DOM output does not invent an authored collection scope or exclusion proof", () => {
  const snapshot = validateDomSnapshot(native(), binding, 100);
  expect(snapshot).not.toHaveProperty("collection_scope");
  expect(snapshot).not.toHaveProperty("excluded");
});

test("unknown scopes and malformed browser-internal exclusion diagnostics refuse", () => {
  const changes = [
    (value: any) => value.snapshot.collection_scope = "all_dom",
    (value: any) => Reflect.deleteProperty(value.snapshot, "collection_scope"),
    (value: any) => Reflect.deleteProperty(value.snapshot, "excluded"),
    (value: any) => value.snapshot.excluded = null,
    (value: any) => value.snapshot.excluded.user_agent_shadow_roots = -1,
    (value: any) => value.snapshot.excluded.user_agent_shadow_roots = 5.5,
    (value: any) => value.snapshot.excluded.user_agent_shadow_roots = 6,
    (value: any) => value.snapshot.excluded.user_agent_shadow_hosts.option = 3.5,
    (value: any) => value.snapshot.excluded.user_agent_shadow_hosts.option = -1,
    (value: any) => value.snapshot.excluded.user_agent_shadow_hosts.option = 2001,
    (value: any) => value.snapshot.excluded.user_agent_shadow_hosts.private_host = 0,
    (value: any) => Reflect.deleteProperty(value.snapshot.excluded.user_agent_shadow_hosts, "other"),
    (value: any) => value.snapshot.excluded.raw_native_document = "private native data",
    (value: any) => { value.snapshot.excluded.user_agent_shadow_roots = 2001;
      value.snapshot.excluded.user_agent_shadow_hosts = { input: 2001, select: 0, option: 0, textarea: 0, button: 0, other: 0 }; },
  ];
  for (const change of changes) {
    const value = authorNative(); change(value);
    expect(() => validateDomSnapshot(value, binding, 100)).toThrow();
  }
});

test("excluding browser internals never hides incomplete authored DOM coverage", () => {
  const value = authorNative(); value.snapshot.omitted.nodes = 1;
  expect(() => validateDomSnapshot(value, binding, 100)).toThrow();
  value.snapshot.complete = value.snapshot.collection_complete = false;
  expect(validateDomSnapshot(value, binding, 100)).toMatchObject({ ...authorCoverage(), complete: false,
    collection_complete: false, omitted: { nodes: 1 } });
});