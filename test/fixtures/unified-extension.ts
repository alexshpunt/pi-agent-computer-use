import { Type } from "@earendil-works/pi-ai";
import { createCodemodeExtension, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import computerUse from "../../src/index.ts";

export default async function unifiedFixture(pi: ExtensionAPI): Promise<void> {
  createCodemodeExtension({ mode: "on" })(pi);
  // Pi awaits the production factory; its session_start handler exists only after setup finishes.
  await computerUse(pi);
  pi.registerTool({
    name: "registered_ui_tools", label: "Registered UI tools",
    description: "Read the real production tool registry and callable loadout.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _update, ctx) {
      const registered = pi.getAllTools().filter(tool => /^(computer_|browser_)/.test(tool.name));
      const names = registered.map(tool => tool.name).sort();
      const exposure = Object.fromEntries(registered.map(tool => [tool.name, tool.exposure ?? "direct"]));
      const callable = ctx.tools.map(tool => tool.name).filter(name => /^(computer_|browser_)/.test(name)).sort();
      const active = pi.getActiveTools().filter(name => /^(computer_|browser_)/.test(name)).sort();
      const details = { names, exposure, callable, active };
      return { content: [{ type: "text", text: JSON.stringify(details) }], details };
    },
  });
}
