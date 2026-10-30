import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { computerPathHelp, computerViewsHelp, COMPUTER_SEARCH_HELP, COMPUTER_DELETE_HELP } from "../../src/provider.ts";
import { IDE_TOOL_NAMES } from "../../src/tool-names.ts";

export default function snapshot(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "computer_capability_snapshot", label: "Capability snapshot",
    description: "Inspect the shared tools and persisted capability state without starting native resources.",
    exposure: "model-only", parameters: Type.Object({}),
    async execute(_id, _input, _signal, _update, ctx) {
      const tools = pi.getAllTools();
      const entries = ctx.sessionManager.getBranch().filter(entry => entry.type === "custom" && entry.customType === "ide-capabilities/v1");
      return {
        content: [{ type: "text", text: JSON.stringify({
          tools: tools.filter(tool => ["read", "search", "delete"].includes(tool.name)).map(tool => ({
            name: tool.name, description: tool.description, parameters: tool.parameters, promptGuidelines: tool.promptGuidelines ?? [],
          })),
          activeTools: pi.getActiveTools(),
          computerTools: tools.filter(tool => tool.namespace?.name === "computer").map(tool => tool.name),
          entries,
          additions: { path: computerPathHelp(IDE_TOOL_NAMES), views: computerViewsHelp(IDE_TOOL_NAMES), search: COMPUTER_SEARCH_HELP, delete: COMPUTER_DELETE_HELP },
        }) }],
        details: undefined,
      };
    },
  });
}
