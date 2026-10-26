import { Text } from "@earendil-works/pi-tui";
import type { TextEditorPluginApi } from "pi-agent-ide/api/text-editor";

type Registration = Parameters<TextEditorPluginApi["addToolRenderer"]>[0];
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
// App text is data, never terminal control sequences. Keep newlines for the existing receipt layout.
const plain = (value: string) => value.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");

/** Preserve computer receipts without replacing IDE's renderer for unrelated edits. */
export function computerActionRenderer(tool: string): Registration {
  return {
    tool,
    matches(value, phase) {
      if (phase === "call") return typeof record(value).path === "string" && String(record(value).path).startsWith("computer:");
      return record(record(record(record(value).details).metadata).semanticAction).kind === "computer-action";
    },
    renderCall(args) {
      return new Text(`${tool} ${plain(String(record(args).path))}`, 0, 0);
    },
    renderResult(result) {
      // content is the provider's safe summary; metadata.receipt can contain private native diagnostics.
      const summary = result.content.find(block => block.type === "text")?.text ?? "";
      const body = summary.replace(/^<system-result\b[^>]*>[\s\S]*?<\/system-result>\r?\n?/, "");
      return new Text(plain(body), 0, 0);
    },
  };
}
