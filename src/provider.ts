import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { connectReadPlugin, READ_PROTOCOL, READ_API_VERSION } from "pi-agent-ide/api/read";
import { connectSearchPlugin, SEARCH_PROTOCOL, SEARCH_API_VERSION } from "pi-agent-ide/api/search";
import { connectTextEditorPlugin, TEXT_EDITOR_PROTOCOL, TEXT_EDITOR_API_VERSION } from "pi-agent-ide/api/text-editor";
import type { ResourceResolver } from "pi-agent-ide/api/resource";
import { connectAgentDocumentation } from "pi-agent-ide/api/documentation";
import { readFile } from "node:fs/promises";
import { ComputerResources, requireComputerAddress, computerResultText, ComputerRequestError, type SandboxFactory, type MachineFactory } from "./computer-resources.ts";
import { computerSource } from "./computer-address.ts";
import type { WebLogEntry } from "./web-browser.ts";
import { computerActionRenderer } from "./computer-action-renderer.ts";
import { computerReadRenderer } from "./computer-read-renderer.ts";
import type { ComputerSession, ComputerResult, Content } from "./session.ts";

const owns = (source: unknown): source is string => typeof source === "string" && source.startsWith("computer:");
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const label = (value: unknown) => typeof value === "string" ? value.replace(/[\r\n\t]/g, " ").slice(0, 1024) : "";

/** Present native resources without dumping provenance; full receipts remain in structured data. */
export function presentComputerResult(resources: Pick<ComputerResources, "appSource">, result: ComputerResult, full = false): string {
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
  if (typeof id === "string" && (d.status === "observed" || (d.dom || d.batch) && d.status === "delivered")) lines.push(`Observation: ${computerSource("observation", id)}`);
  if (d.agent_image) {
    const image = d.agent_image, output = record(image.output), configuration = record(image.configuration);
    lines.push(`Image: ${output.width}x${output.height} ${label(output.mimeType)}; ${label(image.route)}; ${label(image.coordinate_space)}`);
    if (configuration.maxLongEdge !== undefined) lines.push(`Capture: maxLongEdge=${configuration.maxLongEdge}, scale=${configuration.scale}`);
  }
  if (d.source) lines.push(`Source: ${d.source.captured_at}; input=${d.source.capabilities.input}; paint freshness=${d.source.visibility.paint_freshness}`);
  if (d.element_text) {
    const e = d.element_text;
    lines.push(computerResultText(result).split("\n{", 1)[0], `Element: ${e.hint} | ${label(e.role)} | ${label(e.name)}`, ...e.text.split(/\r?\n/));
  } else if (d.verification) {
    const v = d.verification;
    lines.push(computerResultText(result).split("\n{", 1)[0]);
    if (d.dom) lines.push(`Page: ${label(d.dom.title)} | ${label(d.dom.url)} | tab ${d.dom.active ?? "none"}`);
    v.conditions.forEach((condition, i) => {
      const spec = v.spec.conditions[i];
      const check = spec.is ? `is ${spec.is}` : spec.value !== undefined ? `value = ${JSON.stringify(spec.value)}` : spec.contains !== undefined ? `contains ${JSON.stringify(spec.contains)}`
        : spec.title !== undefined ? `title = ${JSON.stringify(spec.title)}` : `url contains ${JSON.stringify(spec.url_contains)}`;
      const seen = condition.observed == null ? "" : label(condition.observed).length > 200 ? label(condition.observed).slice(0, 200) + "…" : label(condition.observed);
      lines.push(`Condition ${i + 1}: ${spec.target ? JSON.stringify(spec.target) + " " : ""}${check} → ${condition.verdict}${condition.observed != null ? ` (observed ${JSON.stringify(seen)})` : ""}${condition.reason ? `; ${label(condition.reason)}` : ""}`);
    });
    if (d.ui) lines.push(`UI: collected=${d.ui.collected}, complete=${d.ui.complete}, truncated=${d.ui.truncated}. Read or Search the observation for elements and hints.`);
  } else if (d.dom) {
    if (d.status !== "observed") {
      const message = computerResultText(result).split("\n{", 1)[0];
      if (message) lines.push(message);
    }
    const dom = d.dom;
    lines.push(dom.active ? `Page: ${label(dom.title)} | ${label(dom.url)} | tab ${dom.active}` : "Page: none; no tab is active. Insert {\"action\":\"switch_tab\",\"tab\":\"<id>\"}.");
    for (const tab of dom.tabs ?? [])
      lines.push(`Tab ${tab.id}${tab.active ? " (active)" : ""}: ${label(tab.title)} | ${label(tab.url)} | ${tab.load}${tab.opener ? ` | opened by ${tab.opener}` : ""}${tab.dialog ? ` | ${tab.dialog} dialog open` : ""}`);
    if (dom.dialog) lines.push(`Dialog: ${dom.dialog.type} ${JSON.stringify(dom.dialog.message)}${dom.dialog.default_value !== undefined ? ` (default ${JSON.stringify(dom.dialog.default_value)})` : ""}. ` +
      "The page waits for it: Insert {\"action\":\"dialog\",\"accept\":true} or false; an accepted prompt takes \"text\". Other page actions refuse until then.");
    for (const item of dom.downloads ?? [])
      lines.push(`Download ${item.id}: ${label(item.filename)} | ${item.state} | tab ${item.tab}${item.bytes !== undefined ? ` | ${item.bytes} bytes` : ""}${item.path ? ` | ${label(item.path)}` : ""}${item.error ? ` | ${label(item.error)}` : ""}`);
    for (const event of dom.events ?? []) lines.push(`Event: ${label(event)}`);
    const entry = (item: WebLogEntry) => `#${item.seq} ${item.at.slice(11, 23)} ${item.tab} ${item.kind}${item.kind === "console" ? `.${item.level}` : ` ${item.level}`}: ${label(item.text)}${item.url ? ` | ${label(item.url)}` : ""}`;
    if (dom.evaluation) lines.push(dom.evaluation.error !== undefined ? `Evaluation error: ${label(dom.evaluation.error)}`
      : `Evaluation result${dom.evaluation.truncated ? " (truncated to 20000 characters)" : ""}: ${dom.evaluation.value}`);
    for (const item of dom.log?.entries ?? []) lines.push(`Log ${entry(item)}`);
    if (dom.log?.omitted) lines.push(`Log: ${dom.log.omitted} more new entries; Read dom:{"log":true} for the retained history.`);
    if (dom.history) {
      lines.push(`Log history: ${dom.history.entries.length} retained entries from #${dom.history.first_seq}${dom.history.dropped ? `; ${dom.history.dropped} older entries were dropped, so earlier history is incomplete` : ""}.`);
      for (const item of dom.history.entries) lines.push(`History ${entry(item)}`);
    }
    if (d.dom.matches !== undefined) lines.push(`Matching snapshot lines: ${d.dom.matches}`);
    if (d.dom.truncated) lines.push("Snapshot truncated; narrow it with dom:{\"target\":...,\"depth\":...}.");
    // With a successor, the compact change list replaces the full snapshot; Read the observation for all of it.
    if (!d.successor) lines.push(...d.dom.snapshot.split("\n"));
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
      `Frames: ${sequence.frames.length}; stop=${sequence.stop_reason}; elapsed_ms=${Math.round(sequence.elapsed_ms)}; actual_fps=${sequence.actual_fps}; last_frame_age_ms=${sequence.last_frame_age_ms === null ? null : Math.round(sequence.last_frame_age_ms)}; skipped_slots=${sequence.skipped_slots.length}; pending_slots=${sequence.pending_slots}`);
  }
  if (d.process) lines.push(d.process.responding
    ? `Process: ${d.process.name} (pid ${d.process.pid}) responds; ${d.process.memory_mb} MB memory, ${d.process.cpu_seconds} s CPU`
    : `Process: ${d.process.name} (pid ${d.process.pid}) is NOT responding; ${d.process.memory_mb} MB memory. Capture and input cannot recover a hung app: wait and read again, or close it.`);
  if (d.text_lines) {
    lines.push(`OCR: ${d.text_lines.length} lines; boxes in this observation's overview pixels. Recognised text can be wrong; confirm with pixels or UI before acting on it.`);
    for (const line of d.text_lines) lines.push(`"${label(line.text)}" | x=${line.x} y=${line.y} w=${line.width} h=${line.height}`);
  }
  if (d.batch) for (const step of d.batch.steps)
    lines.push(`Step ${step.index}: ${step.action} → ${step.outcome}${step.verdict ? ` (${step.verdict})` : ""}${step.reason ? `; ${label(step.reason)}` : ""}`);
  if (d.postcondition) {
    const p = d.postcondition;
    lines.push(`Postcondition: ${p.status}${p.reason ? `; ${p.reason}` : ""}`);
    p.verification?.conditions.forEach((condition, i) => lines.push(`  Condition ${i + 1} → ${condition.verdict}${condition.observed != null ? ` (observed ${JSON.stringify(label(condition.observed))})` : ""}${condition.reason ? `; ${label(condition.reason)}` : ""}`));
  }
  if (d.successor) {
    const s = d.successor, diff = s.diff;
    lines.push(s.observation_id ? `Successor: ${computerSource("observation", s.observation_id)}` : `Successor: none. ${s.reason ?? ""}`);
    if (diff) {
      const page = diff.page ?? {};
      for (const [key, change] of Object.entries(page)) lines.push(`Changed ${key}: ${JSON.stringify(change![0])} → ${JSON.stringify(change![1])}`);
      lines.push(`Changes: ${diff.counts.changed} changed, ${diff.counts.added} added, ${diff.counts.removed} removed${diff.counts.changed + diff.counts.added + diff.counts.removed === 0 && !Object.keys(page).length ? " (no visible change yet)" : ""}`);
      lines.push(...diff.changed.map(line => `~ ${label(line)}`), ...diff.added.map(line => `+ ${label(line)}`), ...diff.removed.map(line => `- ${label(line)}`));
      if (diff.note) lines.push(diff.note);
    } else if (s.reason) lines.push(s.reason);
  }
  if (d.selected_frames) lines.push(`Selected frames: ${d.selected_frames.map(frame => frame.index).join(", ")}; readonly, input=none`);
  lines.push(d.successor?.observation_id ? "Read the successor observation for the full state; it is current for input."
    : d.batch && d.observation_id ? "The batch left this observation current for input. Never replay completed or uncertain steps."
    : d.verification ? (d.verification.verdict === "satisfied" ? "Conditions held; this observation is current for input." : "Not verified: neither proof of success nor of failure beyond the listed verdicts. Never replay uncertain input blindly.")
    : d.dom ? "Insert one JSON action into this observation, e.g. {\"action\":\"click\",\"target\":{\"ref\":\"e2\"}}. Read element:crop|highlight,<ref> or image for page pixels. Refs belong to the latest snapshot."
    : d.window_state_id ? "Use the still-current state once. Cached Read does not renew authority; state does not grant typing or pointer input."
    : d.status === "observed" ? "Detail/display/sequence frames are readonly; fresh window Read is required after detail or input."
    : "Native delivery is not verified application state. Never replay unknown input; Read a fresh window overview/state before another action.");
  const text = lines.join("\n");
  if (full || !d.dom || Buffer.byteLength(text) <= 24_000) return text;
  // Read and Search share the same byte budget; retain whole lines and never split Unicode.
  const preview = fittingLines(lines, 24_000 - 300);
  // A Read of the observation renders slightly different header lines, so page it there rather than by these numbers.
  return `${preview.join("\n")}\nDOM text preview reached its byte limit after ${preview.length} of ${lines.length} lines. Read this observation with offset and limit to page through it (each page names the next offset), or Search it; omitted lines are not absence.`;
}

/** Whole lines from the start that fit a byte budget, never splitting Unicode. */
function fittingLines(lines: readonly string[], budget: number): string[] {
  const kept: string[] = [];
  let bytes = 0;
  for (const line of lines) {
    const size = Buffer.byteLength(line) + 1;
    if (bytes + size > budget) break;
    kept.push(line); bytes += size;
  }
  return kept;
}

/** Preserve uncertainty when a later refusal follows an already-delivered action prefix. */
export function computerEffect(result: ComputerResult): "applied" | "not-applied" | "unknown" {
  if (!result.isError && ["delivered", "observed", "closed"].includes(result.details.status)) return "applied";
  const sequence = record(result.details.state?.sequence);
  const delivered = (typeof sequence.completed === "number" && sequence.completed > 0) || (result.details.batch?.steps.some(step => step.outcome === "delivered") ?? false);
  return result.details.status === "refused" && !delivered ? "not-applied" : "unknown";
}

/**
 * The value a Codemode script receives from a computer Write or Insert. Every outcome resolves with this
 * shape, so scripts branch on `outcome` instead of catching errors. Delivery never verifies application state.
 */
export interface ComputerReceipt {
  /** `refused` sent nothing; `unknown` may have reached the target, so never replay it blindly. */
  outcome: "delivered" | "refused" | "unknown" | "observed" | "closed";
  /** Input effect: `not-applied` only when nothing was delivered, including no earlier sequence step. */
  effect: "applied" | "not-applied" | "unknown";
  /** `validation`: rejected before reaching the target; `target`: the session, browser or native driver answered. */
  stage: "validation" | "target";
  action: string | null;
  source: string;
  window: string | null;
  /** The sandbox address an open_sandbox command started. */
  sandbox?: string;
  /** The machine address a connect command reached. */
  machine?: string;
  /** The new current observation issued by this call, such as a DOM action's next snapshot. */
  observation: string | null;
  /** Whether the addressed observation or window state can no longer be used for input. */
  input_consumed: boolean;
  application_effect: "unverified";
  reason: string | null;
  code: string | null;
  /** Page state after a browser action. */
  page?: { url: string; title: string; tab: string | null; dialog: string | null };
  evaluation?: { value?: string; error?: string; truncated?: boolean };
  /** Verdict of a wait_for/verify command, with one entry per requested condition. */
  verification?: { verdict: "satisfied" | "unsatisfied" | "unknown"; timed_out: boolean; samples: number; elapsed_ms: number; reason?: string;
    conditions: { index: number; verdict: "satisfied" | "unsatisfied" | "unknown"; observed?: string | null; reason?: string }[] };
  /** Per-step results of a sequence or batch. */
  steps?: { index: number; action: unknown; status: unknown; verdict?: string; reason?: string }[];
  /** Why a batch stopped before its last step. */
  stopped?: string;
  /** Declared postcondition: verified by this action, already true before it, not reached, or undecidable. */
  postcondition?: { status: "verified" | "preexisting" | "failed" | "unknown"; reason?: string; verdicts?: string[] };
  /** Compact change list from the action's input observation to `observation`. */
  changes?: { kind: string; changed: string[]; added: string[]; removed: string[]; counts: { changed: number; added: number; removed: number };
    page?: Record<string, unknown>; note?: string };
  /** The same receipt the model sees. */
  text: string;
}
/** Build the script receipt for one Write/Insert result, or for a request rejected before dispatch. */
export function computerReceipt(source: string, action: string | null, outcome: { result: ComputerResult; inputConsumed: boolean; text: string }
  | { error: unknown; inputConsumed: boolean }): ComputerReceipt {
  if ("error" in outcome) {
    const message = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
    const validation = outcome.error instanceof ComputerRequestError;
    return { outcome: validation ? "refused" : "unknown", effect: validation ? "not-applied" : "unknown", stage: validation ? "validation" : "target",
      action, source, window: null, observation: null, input_consumed: outcome.inputConsumed, application_effect: "unverified",
      reason: message, code: validation ? "COMPUTER_INVALID_REQUEST" : "COMPUTER_UNKNOWN", text: message };
  }
  const d = outcome.result.details, state = d.state ?? {};
  const id = d.observation_id ?? d.agent_image?.image_id;
  const issued = typeof id === "string" && d.status !== "refused" && d.status !== "unknown" && (d.status === "observed" || d.dom !== undefined || d.ui !== undefined);
  const next = d.successor?.observation_id ?? (issued ? id : undefined);
  const sequence = record(state.sequence);
  const failed = d.status === "refused" || d.status === "unknown";
  return {
    outcome: d.status === "listed" ? "observed" : d.status, effect: computerEffect(outcome.result), stage: "target", action, source,
    window: typeof d.window_ref === "string" ? computerSource("window", d.window_ref) : null,
    ...(typeof d.sandbox_ref === "string" ? { sandbox: computerSource("sandbox", d.sandbox_ref) } : {}),
    ...(typeof d.machine_ref === "string" ? { machine: computerSource("machine", d.machine_ref) } : {}),
    observation: next ? computerSource("observation", next) : null,
    input_consumed: outcome.inputConsumed, application_effect: "unverified",
    reason: failed ? computerResultText(outcome.result).split("\n{", 1)[0] : null,
    code: typeof state.code === "string" ? state.code : null,
    ...(d.dom ? { page: { url: d.dom.url, title: d.dom.title, tab: d.dom.active ?? null, dialog: d.dom.dialog?.type ?? null } } : {}),
    ...(d.dom?.evaluation ? { evaluation: d.dom.evaluation } : {}),
    ...(d.verification ? { verification: { verdict: d.verification.verdict, timed_out: d.verification.timed_out, samples: d.verification.samples,
      elapsed_ms: d.verification.elapsed_ms, ...(d.verification.reason ? { reason: d.verification.reason } : {}), conditions: d.verification.conditions } } : {}),
    ...(Array.isArray(sequence.steps) ? { steps: (sequence.steps as Record<string, unknown>[]).map(step => ({ index: step.index as number, action: step.action, status: step.status })) } : {}),
    ...(d.batch ? { steps: d.batch.steps.map(step => ({ index: step.index, action: step.action, status: step.outcome, ...(step.verdict ? { verdict: step.verdict } : {}), ...(step.reason ? { reason: step.reason } : {}) })),
      ...(d.batch.stop_reason ? { stopped: d.batch.stop_reason } : {}) } : {}),
    ...(d.postcondition ? { postcondition: { status: d.postcondition.status, ...(d.postcondition.reason ? { reason: d.postcondition.reason } : {}),
      ...(d.postcondition.verification ? { verdicts: d.postcondition.verification.conditions.map(condition => condition.verdict) } : {}) } } : {}),
    ...(d.successor?.diff ? { changes: d.successor.diff } : {}),
    text: outcome.text,
  };
}
function nativeBlocks(body: string, result: ComputerResult | undefined, uiOnly: boolean): Content[] {
  return [{ type: "text", text: body }, ...(uiOnly || !result ? [] : result.details.selected_frames
    ? result.content.slice(1) : result.content.filter(block => block.type === "image"))];
}
/** Extend ordinary IDE tools; CUA and ComputerSession remain the sole native backend and policy owner. */
export async function registerComputerProvider(pi: ExtensionAPI, getSession: (cwd: string) => Promise<ComputerSession>,
  closeSession: () => Promise<ComputerResult>, openSandbox?: SandboxFactory, connectMachine?: MachineFactory): Promise<void> {
  connectAgentDocumentation(pi, [{ id: "computer", description: "Native computer resources, readonly vision and observation-bound input through ordinary IDE tools",
    markdown: await readFile(new URL("../docs/computer-resources.md", import.meta.url), "utf8"),
    triggers: ["read", "search", "write", "insert"].map(tool => ({ tool, resourcePrefixes: ["computer:"] })) }]);
  const resources = new ComputerResources(getSession, closeSession, openSandbox, connectMachine);
  // Pi shutdown destroys every sandbox this session opened.
  pi.on("session_shutdown", () => resources.closeEnvironments());
  const resolver: ResourceResolver = {
    id: "computer",
    async tryResolve(source) {
      if (!owns(source)) return { kind: "not-handled" };
      try {
        const address = requireComputerAddress(source);
        return { kind: "resolved", resource: { source, skipPostEdit: true,
          // An expired reference still resolves, so Write/Insert reach the handler and return a refused receipt.
          read: async () => {
            try { return [{ type: "text", text: resources.descriptor(address) }]; }
            catch (error) { if (error instanceof ComputerRequestError) return [{ type: "text", text: `# Computer resource\nSource: ${source}\n${error.message}` }]; throw error; }
          } } };
      } catch (error) { return { kind: "failed", error }; }
    },
  };
  await Promise.all([
    connectReadPlugin(pi, { protocol: READ_PROTOCOL, apiVersion: READ_API_VERSION, id: "computer", setup(api) {
      api.addResolver({ resolver, priority: -250, renderResult: computerReadRenderer });
      for (const view of ["image", "ui", "full", "state", "dom", "region", "sequence", "frames", "capture", "element", "ocr"])
        api.addView({ view, contentKind: "any", presenter: { id: `computer-${view}`, present: document => document } });
      api.addHandler({ stage: "read", when: { resolvedBy: resolver.id, contentKind: "any" }, async handler(context) {
        const { request, resolverContext } = context;
        const address = requireComputerAddress(context.state!.source);
        const result = await resources.read(address, resolverContext.cwd, request.views, resolverContext.signal);
        const paged = request.offset !== undefined || request.limit !== undefined;
        let body = result ? presentComputerResult(resources, result, paged) : resources.descriptor(address);
        const lines = body.split("\n"), offset = request.offset ?? 1;
        const start = offset < 0 ? Math.max(0, lines.length + offset) : Math.max(0, offset - 1);
        if (request.limit !== undefined && (!Number.isSafeInteger(request.limit) || request.limit < 0)) throw new ComputerRequestError("limit must be a nonnegative text line count.");
        if (!Number.isSafeInteger(offset)) throw new ComputerRequestError("offset must be an integer text line offset.");
        const end = request.limit === undefined ? lines.length : Math.min(lines.length, start + request.limit);
        body = lines.slice(start, end).join("\n");
        // Paging reads cached text only; the footer gives a deterministic next offset or end.
        if (paged)
          body += `\n[Lines ${start + 1}-${end} of ${lines.length}. ${end < lines.length ? `Continue with offset=${end + 1}.` : "End of this observation's text."} The text belongs to this observation; Read the window again for a fresh one.]`;
        const uiOnly = !!result?.details.dom && !result.details.agent_image || (request.views?.includes("ui") ?? false);
        const canonical = nativeBlocks(body, result, uiOnly);
        const truncated = context.audience !== "script" && Buffer.byteLength(body) > 24_000;
        const kept = truncated ? fittingLines(body.split("\n"), 24_000 - 300) : [];
        const preview = truncated ? `${kept.join("\n")}\n[Presentation truncated after ${kept.length} lines. Read again with offset=${start + kept.length + 1} to continue, or narrow with Search. Native script data retains the requested projection.]` : body;
        return { kind: "return", result: { content: nativeBlocks(preview, result, uiOnly), isError: result?.isError,
          details: { source: address.source, resolvedBy: resolver.id, presentationTruncated: truncated, ...(result ? { computer: result.details } : {}) },
          script: { kind: "native", source: address.source, blocks: canonical } } };
      } });
      api.describe({ path: "Read docs:computer for native resources. computer:windows/apps/displays/session and returned computer:window/ref, display/ref, observation/id, window-state/id or sequence/id. Read window overviews before input; display/detail/frames are readonly.",
        views: "Computer: image/ui/full; dom alone or dom:{target,boxes,depth,log} on a window opened by open_browser returns a fresh Playwright aria snapshot with [ref=...] values of the active tab; log:true adds the retained console/page-error/network history; target is {ref} or locator fields role,name,label,text,placeholder,test_id,css,exact,frames. On a DOM observation: image is a page screenshot, element:crop|highlight,<ref> an element image; Search filters its lines. state alone on a window returns fresh restore or management metadata without pixels/UI, plus whether the window is hung and its process memory/CPU. ocr (alone or with capture options on a window, alone on an observation, or with region:x,y,width,height on an observation) adds Windows OCR lines with boxes in overview pixels; use maxLongEdge 3840 for small text. capture:{maxLongEdge,scale,max_elements,max_depth,hints,guides}. region:x,y,width,height or element:inspect|scope|highlight|crop|text,hint on an observation; element:text returns one element's full text. sequence:{duration_ms<=60000,fps<=30,max_frames<=300,timeout_ms,maxLongEdge,scale,region} on window/display reports actual_fps and last_frame_age_ms; frames:first|last|all|endpoints|changed or frames:{indexes:[0]} / {from:0,to:2} on sequence. Detail/frames are readonly; text offset/limit select UI lines, never image cells." });
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
          const literal = value[tool === "write" ? "content" : "text"];
          let action: string | null = tool === "write" ? "type_text" : null;
          if (tool === "insert" && typeof literal === "string") try { const parsed = JSON.parse(literal); if (typeof parsed?.action === "string") action = parsed.action; } catch { /* reported by perform */ }
          let address: ReturnType<typeof requireComputerAddress> | undefined;
          try {
            const fields = tool === "write" ? ["path", "content"] : ["path", "text"];
            if (Object.keys(value).some(key => !fields.includes(key))) throw new ComputerRequestError("Computer input accepts no text anchors, ranges or insertion flags; its observation address binds the target.");
            if (typeof literal !== "string") throw new ComputerRequestError("Provide literal content for Write or one JSON command in Insert text.");
            address = requireComputerAddress(source);
            const result = await resources.perform(address, context.cwd, literal, tool, context.signal);
            const effect = computerEffect(result);
            // Completion of the native request is separate from application-effect certainty.
            const ok = !result.isError && ["delivered", "observed", "closed"].includes(result.details.status);
            const summary = presentComputerResult(resources, result);
            return { source, summary, data: { kind: "computer-action", ok,
              effect, ...result.details,
              receipt: computerResultText(result),
              ...(!ok ? { error: { code: typeof result.details.state?.code === "string" ? result.details.state.code : `COMPUTER_${effect.toUpperCase().replace("-", "_")}`,
                message: computerResultText(result) } } : {}) },
              script: { ...computerReceipt(source, action, { result, inputConsumed: !resources.grantsAuthority(address), text: summary }) } };
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { source, summary: message, data: { kind: "computer-action", ok: false,
              effect: error instanceof ComputerRequestError ? "not-applied" : "unknown", error: { message } },
              script: { ...computerReceipt(source, action, { error, inputConsumed: address ? !resources.grantsAuthority(address) : false }) } };
          }
        },
      });
      api.describe("Computer Write sends content literally through type_text to a fresh UI/image observation address. On a DOM observation of a browser opened with Insert {\"action\":\"open_browser\"} (YOLO: \"profile\":\"agent\" keeps the agent's own logins between sessions), Insert one Playwright action such as {\"action\":\"fill\",\"target\":{\"label\":\"Name\"},\"text\":\"value\"}; actions target the active tab, and tab/navigation/dialog actions are listed in docs:computer. Insert {\"action\":\"open_sandbox\"} into computer:session to work in a separate disposable Windows Sandbox that does not touch the human's desktop; use the returned computer:sandbox/... address for Search, open and close (docs:computer). Insert {\"action\":\"connect\",\"machine\":\"<configured name>\"} into computer:session to work on another machine's desktop over SSH; use the returned computer:machine/... address for Search, Read (displays), open, open_browser, open_sandbox and disconnect. Insert {\"action\":\"put\",\"from\":\"<workspace file>\"}, {\"action\":\"get\",\"name\":\"<file>\",\"to\":\"<workspace path>\"} or {\"action\":\"files\"} into computer:session or a machine address to move files through the session's own folder on that machine (removed on close); point app Open/Save dialogs there. The same addresses take {\"action\":\"clipboard_write\",\"text\"|\"image\":...}, {\"action\":\"clipboard_read\",\"image\":true}, {\"action\":\"record_start\",\"seconds\":30} and {\"action\":\"record_stop\",\"to\":\"<workspace path>\"} (main-display video) and {\"action\":\"audio_record\",\"seconds\":10,\"transcribe\":true} (playback audio with a transcript) in YOLO. Insert {\"action\":\"timeline\",\"events\":[{at_ms,type,...}]} with delivery=foreground into an observation for timed key/button/move/move_relative/wheel/pen events; everything held is released at the end (docs:computer). Insert {\"action\":\"resize\",\"width\":1920,\"height\":1080} into a display address to change that display's resolution in YOLO; closing the session restores it. Insert {\"action\":\"menu\",\"path\":[\"File\",\"Save As...\"]} into an observation to invoke a menu item by its labels, and {\"action\":\"kill\"} into the window address of an app this session opened to force-close it. Insert {\"action\":\"wait_for\"|\"verify\",\"conditions\":[...]} into a window address to check UI state; add \"expect\" or \"successor\":true to an action for a postcondition and change list, or Insert {\"action\":\"batch\",\"steps\":[...]} into an observation for a fail-stop chain (docs:computer). Use no Write or native input on a DOM observation. Use optional ?hint=...&delivery=foreground&delay_ms=0 only on input observations. No implicit select-all, submit or program execution. Computer Insert sends {\"action\":\"restore\"} to a fresh window-state address for explicit restoration and activation without keys/clicks, or one JSON action to an observation, or {\"action\":\"open\",\"app\":\"Exact installed name\"} (YOLO also {\"action\":\"open\",\"path\":\"C:\\\\...\\\\app.exe\",\"args\":[...]}) / {\"action\":\"close\"} to computer:session. Close releases runtime, not documents. Omit window_ref/observation_id in JSON. Input consumes observations even on refusal, except that delivered pixel-only input keeps its observation until the window is resized; refresh with Read. One sequence takes up to 2000 key, click and stroke steps. Never replay unknown prefixes. Foreground input requires an observed background refusal; restore is a separate explicit activation, not input delivery. Safe/YOLO is user-controlled.");
    } }),
  ]);
}
