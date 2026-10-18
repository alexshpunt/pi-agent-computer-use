import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { connectReadPlugin, READ_PROTOCOL, READ_API_VERSION } from "pi-agent-ide/api/read";
import { connectSearchPlugin, SEARCH_PROTOCOL, SEARCH_API_VERSION } from "pi-agent-ide/api/search";
import { connectTextEditorPlugin, TEXT_EDITOR_PROTOCOL, TEXT_EDITOR_API_VERSION } from "pi-agent-ide/api/text-editor";
import type { ResourceResolver } from "pi-agent-ide/api/resource";
import { connectAgentDocumentation } from "pi-agent-ide/api/documentation";
import { readFile } from "node:fs/promises";
import { ComputerResources, requireComputerAddress, computerResultText, ComputerRequestError } from "./computer-resources.ts";
import { computerSource } from "./computer-address.ts";
import { domPreview } from "./dom-resource.ts";
import { computerActionRenderer } from "./computer-action-renderer.ts";
import { computerReadRenderer } from "./computer-read-renderer.ts";
import type { ComputerSession, ComputerResult, Content } from "./session.ts";

const owns = (source: unknown): source is string => typeof source === "string" && source.startsWith("computer:");
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const label = (value: unknown) => typeof value === "string" ? value.replace(/[\r\n\t]/g, " ").slice(0, 1024) : "";

/** Present native resources without dumping provenance; full receipts remain in structured data. */
export function presentComputerResult(resources: Pick<ComputerResources, "appSource">, result: ComputerResult): string {
  const d = result.details, state = d.state ?? {};
  const lines = [`Computer ${d.status} (${d.mode})`];
  if (d.window_ref) lines.push(`Window: ${computerSource("window", d.window_ref)}`);
  if (d.window_state_id && d.status === "observed") {
    const sample = d.window_state_kind === "management" ? record(state.state) : state;
    lines.push(`State: ${computerSource("window-state", d.window_state_id)}`,
      `Window state: minimized=${sample.minimized}, visible=${sample.visible}; foreground=${sample.foreground_at_target}, keyboard_focus=${sample.keyboard_focus_at_target}${d.window_state_kind === "management" ? `; maximized=${sample.maximized}` : ""}`);
    if (d.window_state_kind === "management") {
      lines.push(`Bounds: ${JSON.stringify(sample.bounds)}; source=${sample.bounds_source}; unit=${sample.coordinate_space}`,
        `Current virtual desktop: ${record(sample.virtual_desktop).on_current_desktop}`,
        "Use one Insert move/resize/minimize/maximize/focus or restore. Frame units are desktop pixels, not pointer coordinates.");
    } else lines.push('Insert {"action":"restore"} once explicitly restores and activates this window. No pixel, typing or pointer authority.');
  }
  const invalidManagement = state.code === "tool_output_invalid" ? record(state.invalid_output) : {};
  const management = typeof state.mutation_attempted === "boolean" ? state : invalidManagement;
  if (typeof management.mutation_attempted === "boolean") {
    const measured = record(management.observed), unvalidated = management === invalidManagement;
    lines.push(`${unvalidated ? "Unvalidated" : "Native"} management: ${management.operation}; mutation_attempted=${management.mutation_attempted}, mutation_accepted=${management.mutation_accepted}, postcondition_confirmed=${management.postcondition_confirmed}`,
      `Requested bounds: ${JSON.stringify(management.requested_bounds)}; observed bounds: ${JSON.stringify(measured.bounds ?? null)}; source=${measured.bounds_source ?? "unavailable"}`,
      `${unvalidated ? "Reported" : "Measured"} state: minimized=${measured.minimized}, maximized=${measured.maximized}, visible=${measured.visible}; foreground=${measured.foreground_at_target}, keyboard_focus=${measured.keyboard_focus_at_target}`);
    if (unvalidated) lines.push("The native schema rejected this payload. Keep outcome unknown; do not treat its reported completion as validated success.");
  }
  if (typeof state.restore_attempted === "boolean") {
    lines.push(`Native restore prefix: restore_attempted=${state.restore_attempted}, restore_requested=${state.restore_requested}, restored=${state.restored}`,
      `Activation: activation_attempted=${state.activation_attempted}, activation_succeeded=${state.activation_succeeded}; foreground_changed=${state.foreground_changed}`,
      `Measured state: visible=${state.visible}; foreground=${state.foreground_at_target}, keyboard_focus=${state.keyboard_focus_at_target}`);
  }
  const id = d.observation_id ?? d.agent_image?.image_id;
  if (typeof id === "string" && d.status === "observed") lines.push(`Observation: ${computerSource("observation", id)}`);
  if (d.agent_image) {
    const image = d.agent_image, output = record(image.output), configuration = record(image.configuration);
    lines.push(`Image: ${output.width}x${output.height} ${label(output.mimeType)}; ${label(image.route)}; ${label(image.coordinate_space)}`);
    if (configuration.maxLongEdge !== undefined) lines.push(`Capture: maxLongEdge=${configuration.maxLongEdge}, scale=${configuration.scale}`);
  }
  if (d.source) lines.push(`Source: ${d.source.captured_at}; input=${d.source.capabilities.input}; paint freshness=${d.source.visibility.paint_freshness}`);
  const domProgress = d.dom_action?.progress ?? state.dom_progress;
  if (domProgress) {
    const prefix = record(domProgress);
    lines.push(`DOM action: ${d.dom_action?.status ?? "unknown"}; trusted=false; atomic=false; effects=unverified`,
      `Attempted steps: ${JSON.stringify(prefix.attempted_steps)}; acknowledged: ${JSON.stringify(prefix.acknowledged_steps)}`,
      `In flight: ${prefix.in_flight ?? "none"}; progress=${prefix.status}; reason=${prefix.reason ?? "none"}; cleanup=${prefix.cleanup}`,
      "No automatic retry. Programmatic events do not prove CSS hover, trusted key defaults or application success.");
    if (d.dom_action?.refusal) lines.push(`DOM refusal: ${label(d.dom_action.refusal.code)}; ${label(d.dom_action.refusal.message)}`);
    if (d.dom_action?.observed.length) lines.push(`Acknowledged samples: ${JSON.stringify(d.dom_action.observed)}`);
  }
  if (d.dom_native_detail) {
    const detail = d.dom_native_detail;
    lines.push(`DOM native ${detail.operation}: ${detail.hint}; atomic=${detail.atomic}; input=none; paint=${detail.paint_freshness}`,
      `Physical region: ${JSON.stringify(detail.physical_enclosing_rect)}; screen_physical_pixels`,
      `WGC frame: ${JSON.stringify(detail.frame_bounds)}; original pixels, scale=1, padding=0`,
      `Raster scope: ${label(detail.qualification.browser.product)}; DPR=${detail.qualification.dpr}; native receipt=${detail.native_qualification}`,
      "Runtime/browser/DPR qualification is explicit and separate from the native candidate flag. No input or nested-detail authority.");
  } else if (d.dom_geometry) {
    const sample = d.dom_geometry;
    lines.push(`DOM CSS geometry: ${sample.hint}; readonly, input=none; native mapping=${sample.native_pixel_mapping}; atomic=${sample.atomic}`,
      `Frame: ${label(sample.frame.ref)} (${sample.frame.kind}); method=${sample.method}; received=${sample.received_at}`,
      `Bounds: ${JSON.stringify(sample.bounds)}; ${sample.coordinate_space}; viewport=${sample.viewport}`,
      `Scroll: ${JSON.stringify(sample.scroll)}; visual viewport: ${JSON.stringify(sample.visual_viewport)}`,
      "This sample is not visibility, native image coordinates, input or crop/highlight authority.");
  } else if (d.dom) {
    const dom = domPreview(d.dom);
    if (d.status !== "observed") {
      const message = computerResultText(result).split("\n{", 1)[0];
      if (message) lines.push(message);
      if (typeof state.code === "string") lines.push(`code: ${state.code}`);
    }
    lines.push(`DOM: snapshot=${dom.snapshot_id}, complete=${dom.complete}, collection_complete=${dom.collection_complete}, truncated=${dom.truncated}; returned=${dom.returned_count}/${dom.matched_count}; projection_matches=${dom.matches}, projection_truncated=${dom.projection_truncated}; readonly, input=none`,
      `Collection scope: ${dom.collection_scope ?? "unavailable"}; excluded browser internals: ${dom.excluded ? JSON.stringify(dom.excluded) : "unavailable"}`,
      `Page: ${label(dom.page.title)} | ${label(dom.page.url)}; scope=${dom.scope}`,
      `Omitted: ${JSON.stringify(dom.omitted)}; geometry=${dom.geometry_status}`,
      `Preview: ${dom.elements.length}/${d.dom.elements.length} collected records; use bounded Search or element:inspect for detail.`);
    if (state.cached_dom === true) lines.push("Cached DOM: no new DOM query or authority renewal; inspect the collected snapshot, not current page state.");
    if (!dom.complete || !dom.collection_complete || dom.truncated || dom.projection_truncated) lines.push("Treat absence as unknown outside the returned bounded projection.");
    for (const e of dom.elements) lines.push(`${e.hint} | frame=${label(e.frame.ref)} (${e.frame.kind}) | ${label(e.tag)} | ${label(e.role)} | ${label(e.name)} | ${label(e.value)} | visibility=${e.visibility} | bounds=${JSON.stringify(e.bounds_css)} ${e.coordinate_space}`,
      `  text=${label(e.text)}; text_truncated=${e.text_truncated}; states=${label(JSON.stringify(e.states))}; attributes=${label(JSON.stringify(e.attributes))}`);
    lines.push("DOM hints are readonly. Never use CSS bounds as native image coordinates or input targets; native crop/highlight needs an independent geometry proof.");
  } else if (d.ui) {
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
    if (state.unit === "wheel_detents") {
      lines.push(`Scroll: delta_x=${state.delta_x}, delta_y=${state.delta_y}; unit=wheel_detents`,
        `Native prefix: pointer_attempted=${state.pointer_attempted}, pointer_delivered=${state.pointer_delivered}; attempted_axes=${JSON.stringify(state.attempted_axes)}, delivered_axes=${JSON.stringify(state.delivered_axes)}`);
    }
  }
  if (d.sequence) {
    const sequence = d.sequence;
    lines.push(`Sequence: ${computerSource("sequence", sequence.sequence_id)}`,
      `Frames: ${sequence.frames.length}; stop=${sequence.stop_reason}; elapsed_ms=${Math.round(sequence.elapsed_ms)}; actual_fps=${sequence.actual_fps}; skipped_slots=${sequence.skipped_slots.length}; pending_slots=${sequence.pending_slots}`);
  }
  if (d.selected_frames) lines.push(`Selected frames: ${d.selected_frames.map(frame => frame.index).join(", ")}; readonly, input=none`);
  lines.push(d.dom_geometry ? "The source DOM snapshot remains cached. Read the window with dom for fresh metadata; sample geometry again only while its source stays current."
    : d.dom ? "Read the window with dom view for a fresh bounded DOM query. Use Search or element:inspect on this snapshot. For separately admitted DOM input, use Insert action:dom with source_hint, input_route and a locator request; do not use Write or ordinary input."
    : d.window_state_id ? "Use the still-current state once. Cached Read does not renew authority; state does not grant typing or pointer input."
    : d.status === "observed" ? "Detail/display/sequence frames are readonly; fresh window Read is required after detail or input."
    : "Native delivery is not verified application state. Never replay unknown input; Read a fresh window overview/state before another action.");
  const text = lines.join("\n");
  if (!d.dom || Buffer.byteLength(text) <= 24_000) return text;
  // Read and Search share the same byte budget; retain whole lines and never split Unicode.
  const notice = "DOM text preview reached its byte limit. Use bounded Search or element:inspect; omitted text is not absence or input authority.";
  const preview: string[] = [];
  let bytes = Buffer.byteLength(notice) + 1;
  for (const line of lines) {
    const size = Buffer.byteLength(line) + 1;
    if (bytes + size > 24_000) break;
    preview.push(line); bytes += size;
  }
  return `${preview.join("\n")}\n${notice}`;
}

/** Preserve uncertainty when a later refusal follows an already-delivered action prefix. */
export function computerEffect(result: ComputerResult): "applied" | "not-applied" | "unknown" {
  if (result.details.dom_action) return result.details.status === "refused" && !result.details.dom_action.progress.mutation_attempted ? "not-applied" : "unknown";
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
      api.addResolver({ resolver, priority: -250, renderResult: computerReadRenderer });
      for (const view of ["image", "ui", "full", "state", "dom", "backend", "region", "sequence", "frames", "capture", "element"])
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
        const uiOnly = !!result?.details.dom && !result.details.agent_image || (request.views?.includes("ui") ?? false);
        const canonical = nativeBlocks(body, result, uiOnly);
        const truncated = context.audience !== "script" && Buffer.byteLength(body) > 24_000;
        const preview = truncated ? Buffer.from(body).subarray(0, 24_000).toString("utf8") + "\n[Presentation truncated; narrow UI Search or use text offset/limit. Native script data retains the requested projection.]" : body;
        return { kind: "return", result: { content: nativeBlocks(preview, result, uiOnly), isError: result?.isError,
          details: { source: address.source, resolvedBy: resolver.id, presentationTruncated: truncated, ...(result ? { computer: result.details } : {}) },
          script: { kind: "native", source: address.source, blocks: canonical } } };
      } });
      api.describe({ path: "Read docs:computer for native resources. computer:windows/apps/displays/session and returned computer:window/ref, display/ref, observation/id, window-state/id or sequence/id. Read window overviews before input; display/detail/frames are readonly.",
        views: "Computer: image/ui/full; dom alone or dom:{locator:{role,name,label,text,test_id,css},scope,include_hidden,max_nodes,max_depth} on a window returns fresh readonly DOM; cached DOM Read/Search performs no new query or authority renewal. Use element:scope,hint on a DOM observation for a fresh subtree query. DOM hints grant no Write/Insert or image-coordinate authority. state alone on a window returns fresh restore or management metadata without pixels/UI. backend:default|wgc; capture:{maxLongEdge,scale,max_elements,max_depth,hints,guides}. region:x,y,width,height or element:inspect|scope|highlight|crop,hint on an observation. sequence:{duration_ms,fps,max_frames,timeout_ms,maxLongEdge,scale,region} on window/display; frames:first|last|all|endpoints|changed or frames:{indexes:[0]} / {from:0,to:2} on sequence. Detail/frames are readonly; text offset/limit select UI lines, never image cells." });
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
      api.describe("Search computer:apps or computer:windows for installed-app/permitted-window metadata, or an observation for its collected UI/readonly DOM. Read computer:displays for monitor metadata. Discovery launches nothing; observation Search performs no new native walk or DOM query. Treat missing matches in a partial projection as unknown.");
    } }),
    connectTextEditorPlugin(pi, { protocol: TEXT_EDITOR_PROTOCOL, apiVersion: TEXT_EDITOR_API_VERSION, id: "computer", setup(api) {
      api.addResolver({ resolver, priority: -250 });
      // Compose over IDE's default renderers after every plugin has finished loading.
      let renderersRegistered = false;
      pi.on("session_start", () => {
        if (renderersRegistered) return;
        for (const tool of ["write", "insert"] as const) api.addToolRenderer(computerActionRenderer(tool));
        renderersRegistered = true;
      });
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
            // Completion of the native request is separate from application-effect certainty.
            const ok = !result.isError && ["delivered", "observed", "closed"].includes(result.details.status);
            return { source, summary: presentComputerResult(resources, result), data: { kind: "computer-action", ok,
              effect, ...result.details,
              receipt: computerResultText(result),
              ...(!ok ? { error: { code: typeof result.details.state?.code === "string" ? result.details.state.code : `COMPUTER_${effect.toUpperCase().replace("-", "_")}`,
                message: computerResultText(result) } } : {}) } };
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { source, summary: message, data: { kind: "computer-action", ok: false,
              effect: error instanceof ComputerRequestError ? "not-applied" : "unknown", error: { message } } };
          }
        },
      });
      api.describe("Computer Write sends content literally through type_text to a fresh UI/image observation address. On a DOM observation, use only explicit Insert {\"action\":\"dom\",\"source_hint\":\"current hint\",\"input_route\":\"dom_event\",\"request\":{\"action\":\"fill\",\"locator\":{\"test_id\":\"name\"},\"text\":\"value\"}}. The hint supplies document context; the locator selects the target. The dom_event route is programmatic, not trusted input; trusted currently refuses without fallback. DOM hints grant no ordinary Write, coordinate or UIA authority. Use optional ?hint=...&delivery=foreground&delay_ms=0 only on input observations. No implicit select-all, submit or program execution. Computer Insert sends {\"action\":\"restore\"} to a fresh window-state address for explicit restoration and activation without keys/clicks, or one JSON action to an observation, or {\"action\":\"open\",\"app\":\"Exact installed name\"} / {\"action\":\"close\"} to computer:session. Close releases runtime, not documents. Omit window_ref/observation_id in JSON. Input consumes observations even on refusal; refresh with Read. Never replay unknown prefixes. Foreground input requires an observed background refusal; restore is a separate explicit activation, not input delivery. Safe/YOLO is user-controlled.");
    } }),
  ]);
}
