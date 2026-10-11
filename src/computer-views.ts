import { validateUiCapture, type UiCaptureOptions, type UiRequest } from "./ui-resources.ts";
import { validateSequence, type SequenceOptions, type FrameSelection } from "./temporal-capture.ts";

/** One native Read mode. Details and sampled frames never grant input authority. */
export type ComputerViews =
  | { kind: "overview"; capture: UiCaptureOptions }
  | { kind: "region"; region: { x: number; y: number; width: number; height: number } }
  | { kind: "sequence"; options: SequenceOptions }
  | { kind: "frames"; selection: FrameSelection }
  | { kind: "element"; operation: UiRequest["operation"]; hint: string };

function json(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw Error("Use a JSON options object.");
  return parsed as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw Error("Read view contains unsupported options.");
}

/** Validate owned views before capturing; text offsets are never image coordinates. */
export function parseComputerViews(views: readonly string[] = []): ComputerViews {
  const first = views[0] ?? "";
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
      if (extra !== undefined || !["inspect", "scope", "highlight", "crop"].includes(operation) || !/^[a-z0-9]+:[a-z]+$/.test(hint ?? ""))
        throw Error("Use element:inspect|scope|highlight|crop,current-hint. Crop consumes its overview.");
      return { kind: "element", operation: operation as UiRequest["operation"], hint };
    }
    if (["all", "first", "last", "endpoints", "changed"].includes(value)) return { kind: "frames", selection: value as FrameSelection };
    const raw = json(value);
    const indexes = raw.indexes;
    if (indexes !== undefined) {
      keys(raw, ["indexes"]);
      if (!Array.isArray(indexes) || indexes.length < 1 || indexes.length > 40 || new Set(indexes).size !== indexes.length ||
        indexes.some(i => !Number.isSafeInteger(i) || i < 0 || i > 39)) throw Error("Frame indexes must be distinct integers 0..39.");
    } else {
      keys(raw, ["from", "to"]);
      if (!Number.isSafeInteger(raw.from) || !Number.isSafeInteger(raw.to) || (raw.from as number) < 0 ||
        (raw.to as number) < (raw.from as number) || (raw.to as number) > 39) throw Error("Use an inclusive frame range 0..39.");
    }
    return { kind: "frames", selection: raw as FrameSelection };
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
      keys(options, ["maxLongEdge", "scale", "max_elements", "max_depth", "hints", "guides"]);
      if (Object.keys(options).some(key => key in capture)) throw Error("Duplicate capture option.");
      Object.assign(capture, options);
    } else if (["image", "ui", "full"].includes(view) && capture.granularity === undefined)
      capture.granularity = view as UiCaptureOptions["granularity"];
    else if ((view === "backend:default" || view === "backend:wgc") && capture.backend === undefined)
      capture.backend = view.slice(8) as UiCaptureOptions["backend"];
    else throw Error("Choose image/ui/full with optional backend/capture options, or one region/element/sequence/frames view.");
  }
  if (capture.granularity === "ui" && capture.backend !== undefined) throw Error("UI-only Read has no image backend.");
  validateUiCapture(capture);
  return { kind: "overview", capture };
}
