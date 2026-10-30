import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { computerPathHelp, computerViewsHelp, COMPUTER_SEARCH_HELP, COMPUTER_DELETE_HELP } from "../../src/provider.ts";
import { IDE_TOOL_NAMES, STANDALONE_TOOL_NAMES } from "../../src/tool-names.ts";

export default function fallbackSnapshot(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "computer_fallback_snapshot", label: "Computer fallback snapshot",
    description: "Inspect computer fallback declarations and capability state without accessing native resources.",
    exposure: "model-only", parameters: Type.Object({ enableFallback: Type.Optional(Type.Boolean()) }),
    async execute(_id, input, _signal, _update, ctx) {
      // Select known declarations explicitly so these contract checks do not depend on BM25 prose ranking.
      if (input.enableFallback) pi.setActiveTools([...new Set([...pi.getActiveTools(), "computer_read", "computer_search", "computer_delete"])]);
      const entries = ctx.sessionManager.getBranch().filter(entry => entry.type === "custom" && entry.customType === "ide-capabilities/v1");
      return {
        content: [{ type: "text", text: JSON.stringify({
          tools: pi.getAllTools().filter(tool => ["read", "search", "delete", "computer_read", "computer_search", "computer_delete", "ide_capability_computer"].includes(tool.name)),
          active: pi.getActiveTools(), entries,
          additions: { standalonePath: computerPathHelp(STANDALONE_TOOL_NAMES), standaloneViews: computerViewsHelp(STANDALONE_TOOL_NAMES), path: computerPathHelp(IDE_TOOL_NAMES), views: computerViewsHelp(IDE_TOOL_NAMES), search: COMPUTER_SEARCH_HELP, delete: COMPUTER_DELETE_HELP },
        }) }],
        details: undefined,
      };
    },
  });
}
