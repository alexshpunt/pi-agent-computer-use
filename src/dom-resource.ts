import type { DomBinding, DomElement, DomSnapshot } from "./dom-inspection.ts";
import type { DomGeometry } from "./dom-geometry.ts";
import { elementHint } from "./ui-resources.ts";

/** Readonly DOM metadata. CSS rectangles are never native pixels or input authority. */
export interface DomResource extends Omit<DomSnapshot, "id" | "elements"> {
  window_ref: string;
  observation_id: string;
  snapshot_id: string;
  captured_at: string;
  elements: (Omit<DomElement, "ref"> & { hint: string })[];
  matches: number;
  projection_truncated: boolean;
  geometry_status: "unqualified_native_layout_units";
}
/** Fresh CSS-only sample linked to a current readonly DOM alias, never image/input authority. */
export interface DomGeometryResource extends DomGeometry {
  window_ref: string;
  observation_id: string;
  hint: string;
  frame: DomElement["frame"];
  /** Provider receipt time, not a native browser/paint timestamp. */
  received_at: string;
}
/** Private admission retains native references separately from model-visible aliases. */
export interface DomObservation {
  id: string;
  binding: DomBinding;
  resource: DomResource;
  refs: Map<string, string>;
}
/** Construct fresh aliases without exposing CUA action capabilities. */
export function createDomResource(snapshot: DomSnapshot, binding: DomBinding, window: string, id: string, serial: number): DomObservation {
  const refs = new Map<string, string>();
  const { id: snapshot_id, elements: native, ...metadata } = snapshot;
  const elements = native.map(({ ref, ...row }, index) => {
    const hint = elementHint(serial, index);
    refs.set(hint, ref);
    return { ...row, hint, bounds_css: null };
  });
  // The candidate's DOMSnapshot layout units are not qualified as CSS pixels. Preserve metadata, not guessed geometry.
  const withheld = native.filter(row => row.bounds_css !== null).length;
  return { id, binding: { ...binding }, refs, resource: structuredClone({ ...metadata,
    ...(withheld ? { complete: false, collection_complete: false, omitted: { ...metadata.omitted, metadata: metadata.omitted.metadata + withheld } } : {}),
    window_ref: window, observation_id: id, snapshot_id, captured_at: new Date().toISOString(), elements,
    geometry_status: "unqualified_native_layout_units" as const, matches: elements.length, projection_truncated: false }) };
}
/** Local projection searches only the collected snapshot; native coverage and counts remain unchanged. */
export function projectDom(resource: DomResource, request: { operation: "search" | "inspect" | "crop" | "highlight"; hint?: string; query?: string; limit?: number }): DomResource {
  if (!request || Object.keys(request).some(key => !["operation", "hint", "query", "limit"].includes(key)) ||
    !["search", "inspect", "crop", "highlight"].includes(request.operation) ||
    request.query !== undefined && (typeof request.query !== "string" || request.query.length > 256) ||
    request.limit !== undefined && (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 200)) throw Error("Invalid bounded readonly DOM projection.");
  if (request.operation !== "search" && (!request.hint || request.query !== undefined || request.limit !== undefined))
    throw Error("Selected DOM inspection needs only its current hint.");
  let elements = resource.elements;
  if (request.hint !== undefined) {
    elements = elements.filter(row => row.hint === request.hint);
    if (elements.length !== 1) throw Error("Unknown, foreign or retired DOM hint.");
  }
  if (request.query !== undefined) {
    const query = request.query.toLowerCase();
    elements = elements.filter(row => [row.tag, row.role, row.name, row.value, row.text, ...Object.entries(row.attributes).flat()].join(" ").toLowerCase().includes(query));
  }
  const limit = request.limit ?? 200;
  return structuredClone({ ...resource, elements: elements.slice(0, limit), matches: elements.length, projection_truncated: elements.length > limit });
}
/** Small valid text preview; the complete bounded records remain in structured results. */
export function domPreview(resource: DomResource, limit = 10): DomResource {
  const short = (value: string | null) => value?.slice(0, 128) ?? null;
  return { ...resource, page: { url: resource.page.url.slice(0, 512), title: resource.page.title.slice(0, 128) },
    elements: resource.elements.slice(0, limit).map(row => ({ ...row, name: short(row.name), value: short(row.value), text: row.text.slice(0, 128),
      text_truncated: row.text_truncated || [row.name, row.value, row.text].some(value => (value?.length ?? 0) > 128),
      attributes: Object.fromEntries(Object.entries(row.attributes).slice(0, 4).map(([key, value]) => [key.slice(0, 64), value.slice(0, 128)])),
      states: Object.fromEntries(Object.entries(row.states).slice(0, 8).map(([key, value]) => [key, typeof value === "string" ? value.slice(0, 128) : value])) })) };
}
