import { Text } from "@earendil-works/pi-tui";
import { createReadResultRenderer, type ReadResultRenderer } from "pi-agent-ide/api/read";

const fallback = createReadResultRenderer({ kind: "source" });
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Show native-detail provenance and limits above the image; other reads retain IDE's source renderer. */
export const computerReadRenderer: ReadResultRenderer = (result, options, theme, context) => {
  const details = record(result.details), computer = record(details.computer);
  if (details.resolvedBy !== "computer" || (!computer.dom_native_detail && !computer.dom_native_detail_refusal))
    return fallback(result, options, theme, context);
  const detail = record(computer.dom_native_detail), crop = record(detail.crop), region = record(detail.physical_enclosing_rect), frame = record(detail.frame_bounds);
  const qualification = record(detail.qualification), browser = record(qualification.browser);
  const rect = (value: Record<string, unknown>) => ["x", "y", "width", "height"].every(key => Number.isSafeInteger(value[key]))
    ? `${value.x},${value.y} ${value.width}x${value.height}` : undefined;
  const physical = rect(region), captured = rect(frame);
  if (["crop", "highlight"].includes(String(detail.operation)) && physical && captured &&
    Number.isSafeInteger(crop.width) && Number.isSafeInteger(crop.height) && crop.scale === 1 && crop.padding === 0 &&
    detail.atomic === false && detail.input_authority === false && detail.paint_freshness === "unverified" &&
    detail.native_qualification === "candidate_not_raster_qualified" && typeof detail.hint === "string" &&
    typeof browser.product === "string" && typeof qualification.dpr === "number") {
    // Pi appends an enlarged image below this component. Keep the essential receipt short enough to remain above it.
    const clean = (value: string) => value.replace(/[\x00-\x1f\x7f-\x9f]/g, "");
    return new Text([
      `DOM ${detail.operation}: ${crop.width}x${crop.height} PNG | ${clean(detail.hint)} | atomic=false`,
      `physical ${physical} | WGC ${captured} | scale=1 pad=0`,
      `${clean(browser.product)} | DPR=${qualification.dpr} | candidate_not_raster_qualified`,
      "Pinned runtime/browser | input=none | paint=unverified | no nested detail",
    ].join("\n"), 0, 0);
  }
  // Image blocks remain in the tool result. Never render private structured metadata or attached guides as prose.
  const summary = result.content.find(block => block.type === "text")?.text ?? "";
  const body = summary.replace(/^<system-result\b[^>]*>[\s\S]*?<\/system-result>\r?\n?/, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
  return new Text(body, 0, 0);
};
