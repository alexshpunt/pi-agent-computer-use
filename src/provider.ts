import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { connectReadPlugin, READ_PROTOCOL, READ_API_VERSION } from "pi-agent-ide/api/read";
import { connectSearchPlugin, SEARCH_PROTOCOL, SEARCH_API_VERSION } from "pi-agent-ide/api/search";
import { connectTextEditorPlugin, TEXT_EDITOR_PROTOCOL, TEXT_EDITOR_API_VERSION } from "pi-agent-ide/api/text-editor";
import type { ResourceResolver } from "pi-agent-ide/api/resource";
import { connectAgentDocumentation } from "pi-agent-ide/api/documentation";
import { readFile } from "node:fs/promises";
import { ComputerResources, requireComputerAddress, computerResultText, ComputerRequestError } from "./computer-resources.ts";
import { computerSource } from "./computer-address.ts";
import type { ComputerSession, ComputerResult, Content } from "./session.ts";

const owns = (source: unknown): source is string => typeof source === "string" && source.startsWith("computer:");
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const label = (value: unknown) => typeof value === "string" ? value.replace(/[\r\n\t]/g, " ").slice(0, 1024) : "";

/** Present native resources without dumping provenance; full receipts remain in structured data. */
export function presentComputerResult(resources: Pick<ComputerResources, "appSource">, result: ComputerResult): string {
  const d = result.details, state = d.state ?? {};
  const lines = [`Computer ${d.status} (${d.mode})`];
  if (d.window_ref) lines.push(`Window: ${computerSource("window", d.window_ref)}`);
  const id = d.observation_id ?? d.agent_image?.image_id;
  if (typeof id === "string" && d.status === "observed") lines.push(`Observation: ${computerSource("observation", id)}`);
  if (d.agent_image) {
    const image = d.agent_image, output = record(image.output), configuration = record(image.configuration);
    lines.push(`Image: ${output.width}x${output.height} ${label(output.mimeType)}; ${label(image.route)}; ${label(image.coordinate_space)}`);
    if (configuration.maxLongEdge !== undefined) lines.push(`Capture: maxLongEdge=${configuration.maxLongEdge}, scale=${configuration.scale}`);
  }
  if (d.source) lines.push(`Source: ${d.source.captured_at}; input=${d.source.capabilities.input}; paint freshness=${d.source.visibility.paint_freshness}`);
  if (d.ui) {
    lines.push(`UI: collected=${d.ui.collected}, complete=${d.ui.complete}, truncated=${d.ui.truncated || d.ui.projection_truncated}`);
    for (const e of d.ui.elements) lines.push(`${e.hint} | ${label(e.role)} | ${label(e.name)} | ${label(e.value)} | enabled=${e.enabled} | image_bounds=${JSON.stringify(e.bounds.window_image ?? null)}`);
  } else if (d.status === "listed") {
    for (const kind of ["windows", "apps", "displays"] as const) {
      const rows = state[kind];
      if (!Array.isArray(rows)) continue;
      for (const raw of rows) {
        const row = record(raw);
        const ref = kind === "windows" ? row.window_ref : kind === "displays" ? row.display_ref : undefined;
        const source = typeof ref === "string" ? computerSource(kind === "windows" ? "window" : "display", ref)
          : kind === "apps" && typeof row.app_id === "string" ? resources.appSource(row.app_id) : "(no controllable reference)";
        const metadata = Object.fromEntries(["pid", "window_id", "bounds", "minimized", "owned", "width", "height", "primary"]
          .filter(key => row[key] !== undefined).map(key => [key, row[key]]));
        lines.push(`${source} | ${label(row.name ?? row.title ?? row.app)} | ${JSON.stringify(metadata)}`);
      }
    }
  } else {
    // ComputerSession puts its complete dispatch summary before the native JSON projection.
    const message = computerResultText(result).split("\n{", 1)[0];
    if (message) lines.push(message);
    for (const key of ["code", "native_message", "delivery_mode", "path", "effect"])
      if (typeof state[key] === "string") lines.push(`${key}: ${state[key]}`);
  }
  if (d.sequence) {
    const sequence = d.sequence;
    lines.push(`Sequence: ${computerSource("sequence", sequence.sequence_id)}`,
      `Frames: ${sequence.frames.length}; stop=${sequence.stop_reason}; elapsed_ms=${Math.round(sequence.elapsed_ms)}; actual_fps=${sequence.actual_fps}; skipped_slots=${sequence.skipped_slots.length}; pending_slots=${sequence.pending_slots}`);
  }
  if (d.selected_frames) lines.push(`Selected frames: ${d.selected_frames.map(frame => frame.index).join(", ")}; readonly, input=none`);
  lines.push(d.status === "observed" ? "Detail/display/sequence frames are readonly; fresh window Read is required after detail or input." : "Native delivery is not verified application state. Never replay unknown input; Read a fresh window overview before another action.");
  return lines.join("\n");
}

/** Preserve uncertainty when a later refusal follows an already-delivered action prefix. */
export function computerEffect(result: ComputerResult): "applied" | "not-applied" | "unknown" {
  if (!result.isError && ["delivered", "observed", "closed"].includes(result.details.status)) return "applied";
  const sequence = record(result.details.state?.sequence);
  return result.details.status === "refused" && !(typeof sequence.completed === "number" && sequence.completed > 0) ? "not-applied" : "unknown";
}

function nativeBlocks(body: string, result: ComputerResult | undefined, uiOnly: boolean): Content[] {
  return [{ type: "text", text: body }, ...(uiOnly || !result ? [] : result.details.selected_frames
    ? result.content.slice(1) : result.content.filter(block => block.type === "image"))];
}
/** Extend ordinary IDE tools; CUA and ComputerSession remain the sole native backend and policy owner. */
export async function registerComputerProvider(pi: ExtensionAPI, getSession: (cwd: string) => Promise<ComputerSession>,
  closeSession: () => Promise<ComputerResult>): Promise<void> {
  connectAgentDocumentation(pi, [{ id: "computer", description: "Native computer resources, readonly vision and observation-bound input through ordinary IDE tools",
    markdown: await readFile(new URL("../docs/computer-resources.md", import.meta.url), "utf8"),
    triggers: ["read", "search", "write", "insert"].map(tool => ({ tool, resourcePrefixes: ["computer:"] })) }]);
  const resources = new ComputerResources(getSession, closeSession);
  const resolver: ResourceResolver = {
    id: "computer",
    async tryResolve(source) {
      if (!owns(source)) return { kind: "not-handled" };
      try {
        const address = requireComputerAddress(source);
        return { kind: "resolved", resource: { source, skipPostEdit: true,
          read: async () => [{ type: "text", text: resources.descriptor(address) }] } };
      } catch (error) { return { kind: "failed", error }; }
    },
  };
  await Promise.all([
    connectReadPlugin(pi, { protocol: READ_PROTOCOL, apiVersion: READ_API_VERSION, id: "computer", setup(api) {
      api.addResolver({ resolver, priority: -250 });
      for (const view of ["image", "ui", "full", "backend", "region", "sequence", "frames", "capture", "element"])
        api.addView({ view, contentKind: "any", presenter: { id: `computer-${view}`, present: document => document } });
      api.addHandler({ stage: "read", when: { resolvedBy: resolver.id, contentKind: "any" }, async handler(context) {
        const { request, resolverContext } = context;
        const address = requireComputerAddress(context.state!.source);
        const result = await resources.read(address, resolverContext.cwd, request.views, resolverContext.signal);
        let body = result ? presentComputerResult(resources, result) : resources.descriptor(address);
        const lines = body.split("\n"), offset = request.offset ?? 1;
        const start = offset < 0 ? Math.max(0, lines.length + offset) : Math.max(0, offset - 1);
        if (request.limit !== undefined && (!Number.isSafeInteger(request.limit) || request.limit < 0)) throw new ComputerRequestError("limit must be a nonnegative text line count.");
        if (!Number.isSafeInteger(offset)) throw new ComputerRequestError("offset must be an integer text line offset.");
        body = lines.slice(start, request.limit === undefined ? undefined : start + request.limit).join("\n");
        const uiOnly = request.views?.includes("ui") ?? false;
        const canonical = nativeBlocks(body, result, uiOnly);
        const truncated = context.audience !== "script" && Buffer.byteLength(body) > 24_000;
        const preview = truncated ? Buffer.from(body).subarray(0, 24_000).toString("utf8") + "\n[Presentation truncated; narrow UI Search or use text offset/limit. Native script data retains the requested projection.]" : body;
        return { kind: "return", result: { content: nativeBlocks(preview, result, uiOnly), isError: result?.isError,
          details: { source: address.source, resolvedBy: resolver.id, presentationTruncated: truncated, ...(result ? { computer: result.details } : {}) },
          script: { kind: "native", source: address.source, blocks: canonical } } };
      } });
      api.describe({ path: "Read docs:computer for native resources. computer:windows/apps/displays/session and returned computer:window/ref, display/ref, observation/id or sequence/id. Read window overviews before input; display/detail/frames are readonly.",
        views: "Computer: image/ui/full; backend:default|wgc; capture:{maxLongEdge,scale,max_elements,max_depth,hints,guides}. region:x,y,width,height or element:inspect|scope|highlight|crop,hint on an observation. sequence:{duration_ms,fps,max_frames,timeout_ms,maxLongEdge,scale,region} on window/display; frames:first|last|all|endpoints|changed or frames:{indexes:[0]} / {from:0,to:2} on sequence. Detail/frames are readonly; text offset/limit select UI lines, never image cells." });
    } }),
    connectSearchPlugin(pi, { protocol: SEARCH_PROTOCOL, apiVersion: SEARCH_API_VERSION, id: "computer", setup(api) {
      api.addResolver({ priority: -250, resolver: { id: "computer", readResources: request => owns(request.path) ? [request.path] : [],
        async tryResolve(request, context) {
          if (!owns(request.path)) return { kind: "not-handled" };
          try {
            if (request.include !== undefined || request.exclude !== undefined || request.navigation !== undefined || request.caseSensitive || request.wholeWord)
              throw new ComputerRequestError("Computer Search uses native discovery/UI text predicates, not file globs or symbol navigation.");
            const result = await resources.search(requireComputerAddress(request.path), context.cwd, request.query, request.limit, context.signal);
            return { kind: "resolved", payload: result };
          } catch (error) { return { kind: "failed", error }; }
        },
        format(payload) { const result = payload as ComputerResult; return { ...result, content: [{ type: "text", text: presentComputerResult(resources, result) }] }; },
        toScriptData(payload) { return { kind: "custom", resolverId: "computer", value: (payload as ComputerResult).details }; },
      } });
      api.describe("Search computer:apps or computer:windows for installed-app/permitted-window metadata, computer:displays for monitors, or an observation for its collected UI. Discovery launches nothing; UI Search performs no new native walk.");
    } }),
    connectTextEditorPlugin(pi, { protocol: TEXT_EDITOR_PROTOCOL, apiVersion: TEXT_EDITOR_API_VERSION, id: "computer", setup(api) {
      api.addResolver({ resolver, priority: -250 });
      for (const tool of ["write", "insert"] as const) api.tool(tool).addSemanticHandler({
        matches: input => owns(record(input).path),
        async execute(context, input) {
          const value = record(input), source = context.sourceFor("path");
          try {
            const fields = tool === "write" ? ["path", "content"] : ["path", "text"];
            if (Object.keys(value).some(key => !fields.includes(key))) throw new ComputerRequestError("Computer input accepts no text anchors, ranges or insertion flags; its observation address binds the target.");
            const literal = value[tool === "write" ? "content" : "text"];
            if (typeof literal !== "string") throw new ComputerRequestError("Provide literal content for Write or one JSON command in Insert text.");
            const result = await resources.perform(requireComputerAddress(source), context.cwd, literal, tool, context.signal);
            const effect = computerEffect(result);
            return { source, summary: presentComputerResult(resources, result), data: { kind: "computer-action", ok: effect === "applied",
              effect, ...result.details,
              receipt: computerResultText(result),
              ...(effect !== "applied" ? { error: { code: typeof result.details.state?.code === "string" ? result.details.state.code : `COMPUTER_${effect.toUpperCase().replace("-", "_")}`,
                message: computerResultText(result) } } : {}) } };
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { source, summary: message, data: { kind: "computer-action", ok: false,
              effect: error instanceof ComputerRequestError ? "not-applied" : "unknown", error: { message } } };
          }
        },
      });
      api.describe("Computer Write sends content literally through type_text to a fresh observation address; optional ?hint=...&delivery=foreground&delay_ms=0. No implicit select-all, submit or program execution. Computer Insert sends one JSON action to that observation, or {\"action\":\"open\",\"app\":\"Exact installed name\"} / {\"action\":\"close\"} to computer:session. Close releases runtime, not documents. Omit window_ref/observation_id in JSON. Input consumes observations even on refusal; refresh with Read. Never replay unknown prefixes. Foreground requires an observed background refusal; Safe/YOLO is user-controlled.");
    } }),
  ]);
}
