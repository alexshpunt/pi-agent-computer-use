import { Type, type JsonValue } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { ComputerResources } from "./computer-resources.ts";
import { computerActionRenderer } from "./computer-action-renderer.ts";
import { computerReadRenderer } from "./computer-read-renderer.ts";
import { actionResult, computerNamespace, receiptSchema, registerComputerDelete } from "./computer-tools.ts";
import {
  COMPUTER_INPUT_HELP, COMPUTER_PATH_HELP, COMPUTER_SEARCH_HELP, COMPUTER_VIEWS_HELP,
  performComputer, presentComputerResult, readComputer,
} from "./provider.ts";

const GUIDE = "docs:computer";
const image = Type.Object({ type: Type.Literal("image"), data: Type.String(), mimeType: Type.String() });
const plain = (value: unknown) => String(value).replace(/[\x00-\x1f\x7f-\x9f]/g, " ");

/**
 * Offer computer use without Pi Agent IDE: the same computer: resources through four deferred tools that
 * tool_search finds. Tools stay off the model's tool list until a search loads them.
 */
export function registerStandaloneTools(pi: ExtensionAPI, resources: ComputerResources, guide: string): void {
  const namespace = computerNamespace(guide);
  pi.registerTool({
    name: "computer_read", label: "Computer read", exposure: "deferred", namespace,
    description: `Use computer_read to discover machines, see app windows, displays and browser pages, and get the observations that ground input. Read ${GUIDE} first for addresses, views and commands.`,
    parameters: Type.Object({
      path: Type.String({ description: `${COMPUTER_PATH_HELP} Use ${GUIDE} for the full guide.` }),
      views: Type.Optional(Type.Array(Type.String(), { description: COMPUTER_VIEWS_HELP })),
      offset: Type.Optional(Type.Integer({ description: "First text line of a stored observation, from 1; negative counts from the end." })),
      limit: Type.Optional(Type.Integer({ minimum: 0, description: "Maximum text lines from offset." })),
    }, { additionalProperties: false }),
    // Scripts receive an image block, or several frames, like an IDE image Read; text reads stay strings.
    outputSchema: Type.Union([
      Type.Object({ ...image.properties, note: Type.String() }),
      Type.Object({ type: Type.Literal("images"), note: Type.String(), images: Type.Array(image) }),
    ]),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    renderCall: args => new Text(`computer_read ${plain(args.path)}${args.views?.length ? ` [${plain(args.views.join(", "))}]` : ""}`, 0, 0),
    renderResult: computerReadRenderer,
    async execute(_id, params, signal, _update, ctx) {
      if (params.path === GUIDE) {
        const lines = guide.replace(/\n$/, "").split("\n"), offset = params.offset ?? 1;
        const start = offset < 0 ? Math.max(0, lines.length + offset) : Math.max(0, offset - 1);
        const end = params.limit === undefined ? lines.length : Math.min(lines.length, start + params.limit);
        const rest = end < lines.length ? `\n\n[${lines.length - end} more lines in source. Read "${GUIDE}" with offset=${end + 1} to continue.]` : "";
        return { content: [{ type: "text", text: lines.slice(start, end).join("\n") + rest }],
          details: { source: GUIDE, startLine: start + 1, endLine: end, totalLines: lines.length } };
      }
      const read = await readComputer(resources, params.path, ctx.cwd, params, false, signal);
      const note = read.canonical.find(block => block.type === "text")?.text ?? "";
      const images = read.canonical.filter(block => block.type === "image").map(({ data, mimeType }) => ({ type: "image" as const, data, mimeType }));
      const [first] = images;
      const value: JsonValue | undefined = first === undefined ? undefined : images.length === 1 ? { ...first, note } : { type: "images", note, images };
      return { content: read.content, details: read.details, ...(read.isError ? { isError: true } : {}), ...(value === undefined ? {} : { structuredContent: value }) };
    },
  });
  pi.registerTool({
    name: "computer_search", label: "Computer search", exposure: "deferred", namespace,
    description: "Use computer_search to find windows or installed apps on a machine, or to filter the UI or page lines of an observation without reading it again.",
    parameters: Type.Object({
      path: Type.String({ description: COMPUTER_SEARCH_HELP }),
      query: Type.String({ description: "Name or title text, or regex:<pattern> for a case-insensitive regular expression." }),
      limit: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum results." })),
    }, { additionalProperties: false }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    renderCall: args => new Text(`computer_search ${plain(args.path)} ${plain(JSON.stringify(args.query))}`, 0, 0),
    async execute(_id, params, signal, _update, ctx) {
      const result = await resources.search(resources.address(params.path), ctx.cwd, params.query, params.limit, signal);
      return { content: [{ type: "text", text: resources.shorten(presentComputerResult(result)) }], details: result.details, ...(result.isError ? { isError: true } : {}) };
    },
  });
  for (const tool of ["write", "insert"] as const) {
    const field = tool === "write" ? "content" : "text";
    const renderer = computerActionRenderer(tool);
    pi.registerTool({
      name: `computer_${tool}`, label: `Computer ${tool}`, exposure: "deferred", namespace,
      description: tool === "write"
        ? "Use computer_write to type literal text into the app window of a fresh observation address."
        : "Use computer_insert to send one JSON command: an input action into an observation, open/close/browser/sandbox commands into a machine, or wait/verify into a window.",
      parameters: Type.Object({
        path: Type.String({ description: tool === "write"
          ? "A fresh computer:observation/... address, optionally with ?hint=...&delivery=foreground&delay_ms=0."
          : "The computer: address that receives the command: an observation, window, window-state, display, machine, sandbox or computer:session." }),
        [field]: Type.String({ description: tool === "write" ? "Literal text to type. Nothing is selected, submitted or executed." : COMPUTER_INPUT_HELP }),
      }, { additionalProperties: false }),
      outputSchema: receiptSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      renderCall: args => new Text(`computer_${tool} ${plain((args as { path: string }).path)}`, 0, 0),
      renderResult: renderer.renderResult,
      async execute(_id, params, signal, _update, ctx) {
        const input = params as Record<string, unknown>;
        return actionResult(await performComputer(resources, tool, String(input.path), input, ctx.cwd, signal));
      },
    });
  }
  registerComputerDelete(pi, resources, guide);
}
