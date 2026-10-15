export type DomLocator = Partial<Record<"role" | "name" | "label" | "text" | "test_id" | "css", string>>;
/** Internal CUA capabilities for one admitted tab. Never accepted from model input. */
export interface DomBinding { target_id: string; tab_id: string }
export interface DomReadOptions {
  locator?: DomLocator;
  scope?: string;
  include_hidden?: boolean;
  max_nodes?: number;
  max_depth?: number;
}
export interface DomElement {
  ref: string;
  frame: { ref: string; kind: "main" | "iframe" | "oopif" };
  tag: string;
  attributes: Record<string, string>;
  text: string;
  text_truncated: boolean;
  role: string | null;
  name: string | null;
  value: string | null;
  states: Record<string, unknown>;
  visibility: string;
  bounds_css: { x: number; y: number; width: number; height: number } | null;
  coordinate_space: "document_css_pixels";
}
export interface DomSnapshot {
  id: string;
  complete: boolean;
  collection_complete: boolean;
  matched_count: number;
  returned_count: number;
  truncated: boolean;
  omitted: Record<string, number>;
  scope: "document" | "subtree";
  page: { url: string; title: string };
  elements: DomElement[];
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Expected a DOM object.");
  return value as Record<string, unknown>;
}
function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw Error(message);
}
function text(value: unknown, max = 1024): value is string {
  return typeof value === "string" && [...value].length <= max && !value.includes("\0");
}
const integer = (value: unknown, min: number, max: number) => Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;

/** Admit only exact driver-owned bindings; a later metadata refresh cannot adopt a different tab. */
export function validateDomBinding(value: unknown, admitted?: DomBinding): DomBinding {
  const raw = object(value);
  check(JSON.stringify(raw).length <= 1_048_576 && raw.status === "ok" && raw.mode === "bind" &&
    raw.binding_quality === "exact" && raw.endpoint_access_class === "driver_owned",
    "DOM requires an exact existing driver-owned browser endpoint. No automatic preparation or profile replacement.");
  check(text(raw.target_id, 128) && raw.target_id.length > 0 && Array.isArray(raw.tabs) &&
    raw.tabs.length > 0 && raw.tabs.length <= 256, "DOM binding has no bounded exact tab inventory.");
  const ids = new Set<string>();
  let selected: string | undefined;
  for (const value of raw.tabs) {
    const tab = object(value);
    check(text(tab.tab_id, 128) && tab.tab_id.length > 0 && !ids.has(tab.tab_id) && typeof tab.active === "boolean" &&
      text(tab.url, 8192) && text(tab.title), "DOM tab identity or selection is malformed.");
    ids.add(tab.tab_id);
    if (tab.active) {
      check(selected === undefined, "DOM selected tab is ambiguous; no tab was chosen or activated.");
      selected = tab.tab_id;
    }
  }
  check(selected !== undefined, "DOM selected tab is unknown; no tab was chosen or activated.");
  const binding = { target_id: raw.target_id, tab_id: selected };
  check(!admitted || admitted.target_id === binding.target_id && admitted.tab_id === binding.tab_id,
    "DOM target or selected tab changed. Old references are unavailable; no silent rebinding.");
  return binding;
}
/** Validate ordinary window DOM options. Model input never supplies native target/tab/frame IDs. */
export function validateDomRead(value: unknown): DomReadOptions {
  const raw = object(value);
  check(Object.keys(raw).every(key => ["locator", "scope", "include_hidden", "max_nodes", "max_depth"].includes(key)), "Unsupported DOM option.");
  if (raw.locator !== undefined) {
    const locator = object(raw.locator);
    check(Object.keys(locator).every(key => ["role", "name", "label", "text", "test_id", "css"].includes(key)) &&
      Object.values(locator).every(value => text(value, 256) && value.trim()), "Use bounded exact DOM locators or substring text.");
  }
  if (raw.scope !== undefined) check(text(raw.scope, 128) && /^[a-z0-9]+:[a-z]+$/.test(raw.scope), "Scope requires an issued DOM hint.");
  if (raw.include_hidden !== undefined) check(typeof raw.include_hidden === "boolean", "include_hidden must be boolean.");
  if (raw.max_nodes !== undefined) check(integer(raw.max_nodes, 1, 200), "max_nodes must be in 1..200.");
  if (raw.max_depth !== undefined) check(integer(raw.max_depth, 1, 32), "max_depth must be in 1..32.");
  return structuredClone(raw) as DomReadOptions;
}

/** Check exact admitted native source and bounded readonly records. CSS bounds grant no input authority. */
export function validateDomSnapshot(value: unknown, binding: { target_id: string; tab_id: string }, maxNodes: number): DomSnapshot {
  const raw = object(value), snapshot = object(raw.snapshot), page = object(raw.page);
  check(integer(maxNodes, 1, 200) && JSON.stringify(raw).length <= 1_048_576, "DOM result exceeds the bounded projection.");
  check(raw.status === "ok" && raw.mode === "snapshot" && raw.target_id === binding.target_id && raw.tab_id === binding.tab_id,
    "DOM result changed the admitted target or tab.");
  check(text(page.url, 8192) && text(page.title), "DOM page metadata is malformed.");
  check(text(snapshot.id, 128) && /^p[0-9]+$/.test(snapshot.id) && snapshot.format === "dom_inspect_v1" &&
    [snapshot.complete, snapshot.collection_complete, snapshot.truncated].every(value => typeof value === "boolean"), "DOM snapshot identity or coverage is malformed.");
  check(integer(snapshot.matched_count, 0, 2000) && integer(snapshot.returned_count, 0, maxNodes) &&
    (snapshot.matched_count as number) >= (snapshot.returned_count as number), "DOM match counts are malformed.");
  const omitted = object(snapshot.omitted);
  check(Object.keys(omitted).length === 6 && ["nodes", "depth", "frames", "metadata", "text", "hidden_filtered"].every(key => integer(omitted[key], 0, Number.MAX_SAFE_INTEGER)) &&
    Object.values(omitted).every(value => integer(value, 0, Number.MAX_SAFE_INTEGER)), "DOM omission counts are malformed.");
  check(!snapshot.collection_complete || ["nodes", "depth", "frames", "metadata", "text"].every(key => omitted[key] === 0), "Incomplete collection cannot prove absence.");
  check(!snapshot.complete || snapshot.collection_complete && !snapshot.truncated, "Incomplete traversal cannot prove absence.");
  check(snapshot.scope === "document" || snapshot.scope === "subtree", "Unknown DOM scope.");
  check(Array.isArray(raw.elements) && raw.elements.length === snapshot.returned_count, "DOM returned counts disagree.");
  const refs = new Set<string>(), frames = new Map<string, string>();
  for (const value of raw.elements) {
    const row = object(value), frame = object(row.frame), attributes = object(row.attributes), states = object(row.states);
    check(text(row.ref, 128) && /^p[0-9]+:[0-9]+$/.test(row.ref) && row.ref.startsWith(`${snapshot.id}:`) && !refs.has(row.ref), "DOM refs must be distinct and source-bound.");
    refs.add(row.ref);
    check(text(frame.ref, 128) && frame.ref.length > 0 && ["main", "iframe", "oopif"].includes(String(frame.kind)) &&
      (!frames.has(frame.ref) || frames.get(frame.ref) === frame.kind), "DOM frame identity is malformed.");
    frames.set(frame.ref, frame.kind as string);
    check(text(row.tag, 128) && text(row.text) && typeof row.text_truncated === "boolean" &&
      [row.role, row.name, row.value].every(value => value === null || text(value)), "DOM element metadata is malformed.");
    check(Object.keys(attributes).length <= 64 && Object.entries(attributes).every(([key, value]) => text(key) && text(value)),
      "DOM attributes exceed the bounded projection.");
    check(Object.keys(states).length <= 64 && Object.entries(states).every(([key, value]) => text(key, 128) &&
      (value === null || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value) || text(value))), "DOM states are malformed.");
    check(["visible", "hidden", "unknown"].includes(String(row.visibility)), "Unknown DOM visibility.");
    check(row.coordinate_space === "document_css_pixels" && (row.actions === undefined || Array.isArray(row.actions) && !row.actions.length),
      "Readonly DOM records do not grant native input authority.");
    if (row.bounds_css !== null) {
      const bounds = object(row.bounds_css);
      check(["x", "y", "width", "height"].every(key => typeof bounds[key] === "number" && Number.isFinite(bounds[key])) &&
        (bounds.width as number) >= 0 && (bounds.height as number) >= 0, "DOM CSS bounds are malformed.");
    }
  }
  check(snapshot.truncated === ((snapshot.matched_count as number) > raw.elements.length), "DOM truncation counts disagree.");
  // Never retain unvalidated native extension fields, including inside frame/geometry records.
  const pick = (source: Record<string, unknown>, keys: string[]) => Object.fromEntries(keys.map(key => [key, source[key]]));
  const elements = raw.elements.map(value => {
    const row = object(value);
    return { ...pick(row, ["ref", "tag", "attributes", "text", "text_truncated", "role", "name", "value", "states", "visibility", "coordinate_space"]),
      frame: pick(object(row.frame), ["ref", "kind"]),
      bounds_css: row.bounds_css === null ? null : pick(object(row.bounds_css), ["x", "y", "width", "height"]) };
  });
  return structuredClone({ ...pick(snapshot, ["id", "complete", "collection_complete", "matched_count", "returned_count", "truncated", "omitted", "scope"]),
    page: pick(page, ["url", "title"]), elements }) as unknown as DomSnapshot;
}
