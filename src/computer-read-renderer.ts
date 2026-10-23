import { Text } from "@earendil-works/pi-tui";
import { createReadResultRenderer, type ReadResultRenderer } from "pi-agent-ide/api/read";

const fallback = createReadResultRenderer({ kind: "source" });
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const clean = (value: unknown) => String(value).replace(/[\x00-\x1f\x7f-\x9f]/g, "").slice(0, 200);

/** Show a short provenance line above Playwright page images; other reads retain IDE's source renderer. */
export const computerReadRenderer: ReadResultRenderer = (result, options, theme, context) => {
  const details = record(result.details), computer = record(details.computer), image = record(computer.agent_image);
  if (details.resolvedBy !== "computer" || image.route !== "playwright_screenshot") return fallback(result, options, theme, context);
  const output = record(image.output), state = record(computer.state);
  // Pi appends the enlarged image below this component; keep the receipt short enough to stay above it.
  return new Text([
    `Playwright ${clean(image.kind)} screenshot: ${output.width}x${output.height} PNG | page pixels, input=none`,
    `${clean(state.title)} | ${clean(state.url)}`,
  ].join("\n"), 0, 0);
};
