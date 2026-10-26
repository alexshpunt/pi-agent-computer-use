import { validateUiCapture, type UiCaptureOptions } from "./ui-resources.ts";
import { SEQUENCE_LIMITS, validateSequence, type SequenceOptions, type FrameSelection } from "./temporal-capture.ts";
import { validateWebSnapshot, type WebSnapshotOptions } from "./web-browser.ts";
import { validateRendering, type FrameRendering } from "./contact-sheet.ts";

/** One native Read mode. Details and sampled frames never grant input authority. */
export type ComputerViews =
  | { kind: "state" }
  | { kind: "dom"; options: WebSnapshotOptions }
  | { kind: "overview"; capture: UiCaptureOptions }
  | { kind: "region"; region: { x: number; y: number; width: number; height: number } }
  | { kind: "sequence"; options: SequenceOptions }
  /** Selected frames, one image each, or one sheet or composite image of them. */
  | { kind: "frames"; selection: FrameSelection; rendering?: FrameRendering }
  | { kind: "element"; operation: "inspect" | "scope" | "highlight" | "crop" | "text"; hint: string };

function json(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw Error("Use a JSON options object.");
  return parsed as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const unknown = Object.keys(value).filter(key => !allowed.includes(key));
  if (unknown.length) throw Error(`Read view contains unsupported options: ${unknown.join(", ")}. Allowed: ${allowed.join(", ")}.`);
}

/** Validate owned views before capturing; text offsets are never image coordinates.
 * `ocr` adds Windows text recognition to a window overview, an observation or a region detail.
 * `changes` reads a window's UI and pixels and lists only what changed since its previous observation.
 * `regions` adds icons and text areas found by Cua perception to a window overview or its current observation.
 * `aria` reads a window's UI as a Playwright aria snapshot whose refs are the observation's hints. */
export function parseComputerViews(views: readonly string[] = []): ComputerViews & { ocr?: true; changes?: true; regions?: true; aria?: true } {
  if (views.includes("aria")) {
    const view = parseView(views.filter(view => view !== "aria"));
    if (view.kind !== "overview" || (view.capture.granularity ?? "ui") !== "ui")
      throw Error("Use aria alone or with ui capture options such as max_elements; it renders the UI tree as a Playwright aria snapshot.");
    return { kind: "overview", capture: { ...view.capture, granularity: "ui" }, aria: true };
  }
  if (views.includes("regions")) {
    const rest = parseComputerViews(views.filter(view => view !== "regions"));
    if (rest.ocr || rest.changes || rest.kind !== "overview" || rest.capture.granularity === "ui")
      throw Error("Use regions alone or with image/full capture options; it finds icons and text in pixels.");
    return { ...rest, regions: true };
  }
  if (views.includes("changes")) {
    const view = parseView(views.filter(view => view !== "changes"));
    if (view.kind !== "overview")
      throw Error("Use changes alone (UI and pixels), or with ui, image or full and their capture options; it compares a fresh capture with the window's previous observation.");
    return { kind: "overview", capture: { ...view.capture, granularity: view.capture.granularity ?? "full" }, changes: true };
  }
  if (!views.includes("ocr")) return parseView(views);
  const view = parseView(views.filter(view => view !== "ocr"));
  if (view.kind !== "overview" && view.kind !== "region") throw Error("Use ocr alone or with region:x,y,width,height or capture options; it reads text from pixels.");
  if (view.kind === "overview" && view.capture.granularity === "ui") throw Error("ocr needs pixels; use image or full granularity.");
  return { ...view, ocr: true };
}

function parseView(views: readonly string[]): ComputerViews {
  const first = views[0] ?? "";
  if (views.some(view => view === "dom" || view.startsWith("dom:"))) {
    if (views.length !== 1) throw Error("Use dom alone: a DOM snapshot has no image, UI, state or capture options.");
    return { kind: "dom", options: validateWebSnapshot(first === "dom" ? {} : json(first.slice(4))) };
  }
  if (views.includes("state")) {
    if (views.length !== 1) throw Error("Use state alone: window metadata has no pixels, UI or capture options.");
    return { kind: "state" };
  }
  if (/^(sequence|frames|element):/.test(first)) {
    if (views.length !== 1) throw Error("Use one sequence, frames or element view without overview options.");
    const value = first.slice(first.indexOf(":") + 1);
    if (first.startsWith("sequence:")) {
      const raw = json(value);
      keys(raw, ["duration_ms", "fps", "max_frames", "timeout_ms", "maxLongEdge", "scale", "region"]);
      const options = raw as unknown as SequenceOptions;
      validateSequence(options);
      if (options.maxLongEdge !== undefined && (!Number.isSafeInteger(options.maxLongEdge) || options.maxLongEdge < 64 || options.maxLongEdge > 4096) ||
        options.scale !== undefined && (!Number.isFinite(options.scale) || options.scale < 0.05 || options.scale > 1)) throw Error("Invalid sequence image size/scale.");
      if (options.region) keys(options.region, ["x", "y", "width", "height"]);
      return { kind: "sequence", options };
    }
    if (first.startsWith("element:")) {
      const [operation, hint, extra] = value.split(",");
      // UI hints look like "3:ab"; Playwright aria refs look like "e12" or "f1e3".
      if (extra !== undefined || !["inspect", "scope", "highlight", "crop", "text"].includes(operation) || !/^[a-z0-9]+(:[a-z]+)?$/i.test(hint ?? ""))
        throw Error("Use element:inspect|scope|highlight|crop|text,<UI hint>, or element:crop|highlight,<aria ref> on a DOM observation.");
      return { kind: "element", operation: operation as Extract<ComputerViews, { kind: "element" }>["operation"], hint };
    }
    if (["all", "first", "last", "endpoints", "changed"].includes(value)) return { kind: "frames", selection: value as FrameSelection };
    const raw = json(value);
    // Rendering options (as, region, columns, maxLongEdge) go with any selection: select, indexes or from/to.
    const rendering = validateRendering(raw);
    for (const key of ["as", "region", "columns", "maxLongEdge"]) delete raw[key];
    if (rendering && !Object.keys(raw).length) raw.select = "all";
    if (raw.select !== undefined) {
      keys(raw, ["select"]);
      if (!["all", "first", "last", "endpoints", "changed"].includes(raw.select as string)) throw Error("select is all, first, last, endpoints or changed.");
      return { kind: "frames", selection: raw.select as FrameSelection, ...(rendering ? { rendering } : {}) };
    }
    const indexes = raw.indexes;
    if (indexes !== undefined) {
      keys(raw, ["indexes"]);
      if (!Array.isArray(indexes) || indexes.length < 1 || indexes.length > SEQUENCE_LIMITS.selected || new Set(indexes).size !== indexes.length ||
        indexes.some(i => !Number.isSafeInteger(i) || i < 0 || i >= SEQUENCE_LIMITS.max_frames)) throw Error(`Select 1..${SEQUENCE_LIMITS.selected} distinct frame indexes 0..${SEQUENCE_LIMITS.max_frames - 1}.`);
    } else {
      keys(raw, ["from", "to"]);
      if (!Number.isSafeInteger(raw.from) || !Number.isSafeInteger(raw.to) || (raw.from as number) < 0 ||
        (raw.to as number) < (raw.from as number) || (raw.to as number) >= SEQUENCE_LIMITS.max_frames || (raw.to as number) - (raw.from as number) >= SEQUENCE_LIMITS.selected)
        throw Error(`Use an inclusive frame range within 0..${SEQUENCE_LIMITS.max_frames - 1} of at most ${SEQUENCE_LIMITS.selected} frames.`);
    }
    return { kind: "frames", selection: raw as FrameSelection, ...(rendering ? { rendering } : {}) };
  }
  const capture: UiCaptureOptions = {};
  for (const view of views) {
    if (view.startsWith("region:")) {
      if (views.length !== 1) throw Error("Use one rectangular region view without overview options.");
      const values = view.slice(7).split(",");
      const [x, y, width, height] = values.map(Number);
      if (values.length !== 4 || values.some(value => !value.trim()) ||
        ![x, y, width, height].every(Number.isFinite) || x < 0 || y < 0 || width <= 0 || height <= 0)
        throw Error("Use region:x,y,width,height in local overview-image pixels.");
      return { kind: "region", region: { x, y, width, height } };
    }
    if (view.startsWith("capture:")) {
      const options = json(view.slice(8));
      // granularity may also come from the image/ui/full views; both forms mean the same.
      keys(options, ["granularity", "maxLongEdge", "scale", "max_elements", "max_depth", "hints", "guides"]);
      const duplicate = Object.keys(options).filter(key => key in capture);
      if (duplicate.length) throw Error(`${duplicate.join(", ")} is given twice: once as a view and once in capture.`);
      Object.assign(capture, options);
    } else if (["image", "ui", "full"].includes(view)) {
      if (capture.granularity !== undefined) throw Error(`Choose one of image, ui or full; got ${capture.granularity} and ${view}.`);
      capture.granularity = view as UiCaptureOptions["granularity"];
    } else throw Error(`Unknown view ${view}. Choose image/ui/full with optional capture options, or one region/element/sequence/frames view.`);
  }
  validateUiCapture(capture);
  return { kind: "overview", capture };
}
