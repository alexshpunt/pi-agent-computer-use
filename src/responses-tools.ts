import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** A function tool of ours that left strictness unsaid. Explicit strictness, other tool kinds and other tools stay as they are. */
const unsaid = (tool: unknown, names: ReadonlySet<string>): tool is Record<string, unknown> =>
  record(tool) && tool.type === "function" && typeof tool.name === "string" && names.has(tool.name) && tool.strict === undefined;

/** Copy of `tools` with `strict: false` on the tools that need it, or `tools` itself when none does. */
function relaxed(tools: readonly unknown[], names: ReadonlySet<string>): readonly unknown[] {
  const next = tools.map(tool => unsaid(tool, names) ? { ...tool, strict: false } : tool);
  return next.some((tool, index) => tool !== tools[index]) ? next : tools;
}

/**
 * Say `strict: false` on Computer Use's function tools in an OpenAI Responses request, without changing their schemas.
 *
 * Pi leaves strictness out for GitHub Copilot, and Responses then treats a tool as strict: every optional property
 * becomes required, so the model fills them all (`profile: "agent"`, an empty `path`, a `sandbox` object) and
 * `computer_open` refuses the call. Pi puts the tools in `payload.tools`, or in `additional_tools` items of
 * `payload.input`; both are covered. Nothing else in the payload changes, and the payload itself is returned when no tool needed it.
 */
export function preserveToolOmission(payload: unknown, names: ReadonlySet<string>): unknown {
  if (!record(payload)) return payload;
  let next: Record<string, unknown> = payload;
  if (Array.isArray(payload.tools)) {
    const tools = relaxed(payload.tools, names);
    if (tools !== payload.tools) next = { ...next, tools };
  }
  const original = payload.input;
  if (Array.isArray(original)) {
    const input = original.map(item => {
      if (!record(item) || item.type !== "additional_tools" || !Array.isArray(item.tools)) return item;
      const tools = relaxed(item.tools, names);
      return tools === item.tools ? item : { ...item, tools };
    });
    if (input.some((item, index) => item !== original[index])) next = { ...next, input };
  }
  return next;
}

/** Keep the tools of one namespace from turning strict on the OpenAI Responses route. Other routes and other tools are untouched. */
export function registerToolOmission(pi: Pick<ExtensionAPI, "on" | "getAllTools">, namespace: string): void {
  pi.on("before_provider_request", (event, context) => {
    if (context.model?.api !== "openai-responses") return;
    const names = new Set(pi.getAllTools().filter(tool => tool.namespace?.name === namespace).map(tool => tool.name));
    return preserveToolOmission(event.payload, names);
  });
}
