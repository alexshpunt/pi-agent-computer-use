import type { Component } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  actionState, elementRows, firstReason, HeadingLine, OutcomeCard, oneLine, problemNotes, record, size, successorNotes, targetNames,
  type ComputerState, type DescribeAddress, type Heading, type Note, type Outcome,
} from "./computer-tui.ts";

/** A tool result as Pi gives it to a renderer; only the typed fields are read, never the receipt text. */
interface ToolResult { content?: { type: string; text?: string }[]; details?: unknown; isError?: boolean }
interface RenderOptions { expanded: boolean; isPartial: boolean }
interface RenderContext { isError?: boolean; lastComponent?: Component; args?: unknown }

const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const str = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value : undefined;
const num = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) ? value : undefined;
const last = (address: string) => address.replace(/^computer:/, "").replace(/\?.*$/, "");

/** The window a person is looking at: its title when this run listed one, otherwise its short address. */
function windowLabel(describe: DescribeAddress | undefined, address: unknown): string {
  const source = str(address);
  if (!source) return "window";
  const title = describe?.(source)?.title;
  return title ? `“${oneLine(title, 60)}”` : last(source);
}
const machineOf = (describe: DescribeAddress | undefined, at: unknown) => {
  const source = str(at);
  return source ? describe?.(source)?.machine ?? /^computer:machine\/([^/?]+)/.exec(source)?.[1] ?? /^computer:([a-z0-9_-]+)\/[a-z]\d/.exec(source)?.[1] : undefined;
};
const base = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;
/** Where an input is aimed: a ref or locator, or a point. */
const aimed = (args: Record<string, unknown>) => args.target !== undefined ? oneLine(args.target, 60) : args.x !== undefined ? `${args.x},${args.y}` : "";
/** Argument names whose values are what the agent typed or pasted; headings and details never repeat them. */
const LITERAL = new Set(["text", "content", "value", "values", "data", "script", "code"]);

/** Exact scalar arguments for the expanded heading, without literal input. */
function argumentDetails(args: Record<string, unknown>): [string, string][] {
  return Object.entries(args).filter(([key, value]) => !LITERAL.has(key) && ["string", "number", "boolean"].includes(typeof value))
    .map(([key, value]) => [key, oneLine(value, 120)] as [string, string]);
}

/** The heading of one typed computer_* call: what it acts on, then the options that matter. */
export function typedHeading(tool: string, rawArgs: unknown, describe?: DescribeAddress): Heading {
  const args = record(rawArgs), window = windowLabel(describe, args.window);
  const base_: Heading = { tool, details: argumentDetails(args) };
  const heading = (primary: string, ...qualifiers: (string | undefined | false)[]): Heading =>
    ({ ...base_, primary: { text: primary }, qualifiers: qualifiers.filter((q): q is string => typeof q === "string" && q.length > 0) });
  switch (tool) {
    case "computer_open": {
      const what = str(args.app) ?? (str(args.path) ? base(String(args.path)) : undefined) ?? str(args.url) ?? str(args.browser) ??
        (args.sandbox ? "sandbox" : args.isolated_session ? "isolated session" : args.webview2_debugging ? "WebView2 debugging" : undefined) ?? window;
      return heading(what, machineOf(describe, args.at), str(args.browser) && str(args.url) ? str(args.browser) : undefined);
    }
    case "computer_window": {
      const action = String(args.action ?? "");
      const detail = action === "move" ? `move ${args.x},${args.y}` : action === "resize" ? `resize ${args.width}×${args.height}` : action === "name" ? `name ${args.as}` : action;
      return heading(window, detail);
    }
    case "computer_view": {
      const at = args.x !== undefined || args.y !== undefined ? `at ${args.x ?? "_"},${args.y ?? "_"}` : undefined;
      const dims = args.width !== undefined || args.height !== undefined ? `${args.width ?? "_"}×${args.height ?? "_"}` : undefined;
      return heading(last(String(args.viewport ?? "viewport")), at, dims);
    }
    case "computer_wait": return heading(window, String(args.mode ?? "wait"), `${array(args.conditions).length} condition(s)`);
    case "computer_browser": return heading(window, String(args.action ?? ""), str(args.url) ?? str(args.tab));
    case "computer_files": return heading(String(args.machine ?? "machine"), String(args.action ?? ""), str(args.from) ?? str(args.name));
    case "computer_clipboard": return heading(String(args.machine ?? "machine"), String(args.action ?? ""), str(args.image));
    case "computer_record": return heading(windowLabel(describe, args.at), String(args.action ?? ""), num(args.seconds) !== undefined ? `${args.seconds} s` : num(args.duration_ms) !== undefined ? `${args.duration_ms} ms` : undefined);
    case "computer_click": return heading(window, aimed(args), num(args.count) ? `×${args.count}` : undefined, str(args.button) && args.button !== "left" ? String(args.button) : undefined);
    case "computer_hover": return heading(window, aimed(args));
    case "computer_drag": return heading(window, `${aimed(record(args.from)) || "?"} → ${aimed(record(args.to)) || "?"}`);
    case "computer_scroll": return heading(window, aimed(args), `${args.delta_x ?? 0},${args.delta_y ?? 0}`);
    case "computer_type": return heading(window, aimed(args), `${String(args.text ?? "").length} chars`, args.submit ? "+ Enter" : undefined);
    case "computer_press": return heading(window, String(args.key ?? ""), num(args.hold_ms) ? `${args.hold_ms} ms` : undefined);
    case "computer_select": {
      const choice = Array.isArray(args.menu) ? (args.menu as string[]).map(item => oneLine(item, 30)).join(" > ")
        : args.checked !== undefined ? (args.checked ? "checked" : "unchecked") : array(args.values).length ? `${array(args.values).length} value(s)` : "";
      return heading(window, aimed(args), choice);
    }
    case "computer_timeline": return heading(window, `${array(args.events).length} events`);
    case "computer_display": return heading(String(args.display ?? "display"), `${args.width}×${args.height}`);
    default: return heading(last(String(args.path ?? args.window ?? args.at ?? "")));
  }
}

const KINDS: Record<string, string> = { w: "window", o: "observation", s: "sequence", a: "app", b: "sandbox", d: "display" };
/** A short computer address in words: `computer:local/w1tt` is "window w1tt" on machine local. */
function addressWords(address: string): { what: string; machine?: string } {
  const short = /^computer:([a-z0-9_-]+)\/([wosabd])(\d+[a-z]{2})(?:\/([a-z0-9_-]+))?$/.exec(address.replace(/\?.*$/, ""));
  if (short) return { what: `${KINDS[short[2]]} ${short[2]}${short[3]}${short[4] ? `/${short[4]}` : ""}`, machine: short[1] };
  const machine = /^computer:machine\/([^/?]+)(?:\/(windows|apps|displays))?/.exec(address);
  if (machine) return { what: machine[2] ? `${machine[1]} ${machine[2]}` : `machine ${machine[1]}`, machine: machine[1] };
  if (address === "computer:session") return { what: "session" };
  return { what: last(address) };
}

/** The heading of an IDE tool call on a computer address (Read/Search/Write/Insert/Delete and the standalone twins). */
export function resourceHeading(tool: string, rawArgs: unknown, describe?: DescribeAddress): Heading {
  const args = record(rawArgs), path = str(args.path) ?? "";
  const views = array(args.views).filter((v): v is string => typeof v === "string");
  const { what, machine } = addressWords(path);
  const title = path.startsWith("computer:") ? describe?.(path)?.title : undefined;
  const qualifiers: string[] = [];
  if (typeof args.query === "string") qualifiers.push(`“${oneLine(args.query, 60)}”`);
  if (views.length) qualifiers.push(`views ${views.join(",")}`);
  if (machine && !/^machine /.test(what) && !/^[a-z0-9_-]+ (windows|apps|displays)$/.test(what)) qualifiers.push(machine);
  return { tool, primary: { text: title ? `“${oneLine(title, 60)}”` : what }, qualifiers, details: [["path", path], ...argumentDetails(args).filter(([key]) => key !== "path")] };
}

const sizeFact = (bounds: unknown) => { const b = record(bounds); return size(b.width, b.height); };

/** Facts, notes and rows of a window-management receipt. */
function managementFacts(state: Record<string, unknown>): { facts: string[]; notes: Note[] } {
  const operation = str(state.operation), observed = record(record(state.observed).bounds), requested = record(state.requested_bounds);
  const facts: string[] = [];
  if (operation) facts.push(operation);
  const now = size(observed.width, observed.height), want = size(requested.width, requested.height);
  if (now) facts.push(now);
  const notes: Note[] = [];
  if (now && want && now !== want && state.postcondition_confirmed === true) notes.push({ tone: "muted", text: `Windows settled at ${now} for the requested ${want}.` });
  return { facts, notes };
}

/** The outcome of one typed computer_* action, from the semantic data its result carries. */
export function actionOutcome(result: ToolResult, isError: boolean, describe?: DescribeAddress): Outcome {
  const data = record(record(record(result.details).metadata).semanticAction);
  if (data.kind !== "computer-action") {
    // A result that is not a computer receipt (a schema or runtime failure): say that it failed, and why in one line.
    const text = result.content?.find(block => block.type === "text")?.text;
    return { state: isError ? "failed" : "delivered", notes: isError && firstReason(text) ? [{ tone: "error", text: firstReason(text)! }] : [] };
  }
  const script = record(data.script), state = actionState(data, isError);
  const windowAddress = str(script.window) ?? str(data.source);
  const named = targetNames(describe, windowAddress);
  // The heading already names the window by its title; the status line adds only where it ran.
  const facts = [str(data.machine) ?? named.machine ?? machineOf(describe, windowAddress)].filter((f): f is string => !!f);
  const notes = problemNotes(state, data);
  const rows: string[] = [];
  const details: [string, string][] = [];
  const stateRecord = record(data.state);
  if (typeof stateRecord.mutation_attempted === "boolean") {
    const managed = managementFacts(stateRecord);
    facts.push(...managed.facts); notes.push(...managed.notes);
  }
  if (state === "delivered" || state === "observed") {
    const ui = record(data.ui), image = record(record(data.agent_image).output);
    const dims = size(image.width, image.height);
    if (dims) facts.push(`image ${dims}`);
    if (num(ui.collected) !== undefined) { facts.push(`UI ${ui.collected} element${ui.collected === 1 ? "" : "s"}${ui.truncated === true ? " (truncated)" : ""}`); rows.push(...elementRows(ui.elements)); }
    const successor = successorNotes(data.successor);
    notes.push(...successor.notes); rows.push(...successor.rows);
  }
  const code = str(script.code) ?? str(record(data.error).code);
  if (code) details.push(["code", code]);
  if (str(script.stage)) details.push(["stage", String(script.stage)]);
  if (str(script.window)) details.push(["window", String(script.window)]);
  if (str(script.observation)) details.push(["observation", String(script.observation)]);
  if (str(data.mode)) details.push(["mode", String(data.mode)]);
  const delivery = str(stateRecord.delivery_mode);
  if (delivery) details.push(["delivery", delivery]);
  if (str(script.application_effect)) details.push(["application effect", String(script.application_effect)]);
  return { state, facts, notes, rows, details };
}

/** The human-readable lines of a result's text, without the model-only envelope and attached guides. */
function contentRows(result: ToolResult): string[] {
  const text = (result.content ?? []).filter(block => block.type === "text" && typeof block.text === "string" && !block.text.startsWith("\n\n---\n\n# Guide:"))
    .map(block => block.text!.replace(/^<system-result\b[^>]*>[\s\S]*?<\/system-result>\r?\n?/, "")).join("\n");
  return text.split(/\r?\n/).map(line => line.trimEnd()).filter(Boolean);
}

const READ_STATES = new Set<ComputerState>(["observed", "listed", "delivered", "closed", "refused", "unknown"]);
const stateOf = (status: unknown, isError: boolean, fallback: ComputerState): ComputerState =>
  READ_STATES.has(status as ComputerState) ? status as ComputerState : isError ? "failed" : fallback;

/** The outcome of a Read of a computer address, whether through the IDE or computer_read. */
export function readOutcome(result: ToolResult, isError: boolean, describe?: DescribeAddress): Outcome {
  const outer = record(result.details), d = record(outer.computer ?? outer.payload ?? result.details);
  const state = stateOf(d.status, isError, "observed");
  const source = str(d.window_ref) ? `computer:window/${d.window_ref}` : str(outer.source);
  const named = targetNames(describe, source);
  const facts = [str(d.machine) ?? named.machine, named.title].filter((f): f is string => !!f);
  const notes: Note[] = [], rows: string[] = [], details: [string, string][] = [];
  const image = record(record(d.agent_image).output), dims = size(image.width, image.height);
  if (dims) facts.push(`image ${dims}`);
  const page = record(d.state);
  if (record(d.agent_image).route === "playwright_screenshot") {
    facts.push(`${oneLine(record(d.agent_image).kind ?? "page", 20)} screenshot`);
    if (str(page.title)) facts.push(`“${oneLine(page.title, 60)}”`);
    if (str(page.url)) facts.push(oneLine(page.url, 80));
  }
  const crop = record(d.screenshot_crop);
  if (size(crop.width, crop.height)) facts.push(`crop ${size(crop.width, crop.height)}`);
  const ui = record(d.ui);
  if (num(ui.collected) !== undefined) {
    facts.push(`UI ${ui.collected}${num(ui.native_total) !== undefined && ui.native_total !== ui.collected ? `/${ui.native_total}` : ""} element${ui.collected === 1 ? "" : "s"}${ui.truncated === true ? " (truncated)" : ""}`);
    rows.push(...elementRows(ui.elements));
  }
  const dom = record(d.dom);
  if (str(dom.snapshot)) {
    facts.push(`page ${oneLine(dom.title ?? dom.url ?? "", 50)}`.trim());
    rows.push(...String(dom.snapshot).split("\n").map(line => line.trimEnd()).filter(Boolean));
    if (dom.truncated === true) notes.push({ tone: "warning", text: "The page snapshot is truncated; narrow it with dom:{target,depth}." });
  }
  const lines = array(d.text_lines);
  if (lines.length) { facts.push(`OCR ${lines.length} line${lines.length === 1 ? "" : "s"}`); rows.push(...lines.map(line => oneLine(array(record(line).words).map(w => record(w).text).join(" ")))); }
  const regions = array(d.visual_regions);
  if (regions.length) facts.push(`${regions.length} region${regions.length === 1 ? "" : "s"}`);
  const element = record(d.element_text);
  if (str(element.text)) { facts.push(`element ${oneLine(element.role ?? "", 20)} ${oneLine(element.name ?? "", 40)}`.trim()); rows.push(...String(element.text).split(/\r?\n/)); if (element.cut === true) notes.push({ tone: "muted", text: "The element's text is cut." }); }
  const sequence = record(d.sequence);
  if (num(sequence.frame_count) !== undefined) facts.push(`${sequence.frame_count} frames`);
  const changes = successorNotes(d.changes); notes.push(...changes.notes); rows.push(...changes.rows);
  const stateRecord = record(d.state);
  if (d.window_state_kind === "management" || stateRecord.bounds !== undefined) {
    const sample = d.window_state_kind === "management" ? record(stateRecord.state) : stateRecord, bs = sizeFact(sample.bounds);
    if (bs) facts.push(bs);
    if (sample.minimized === true) facts.push("minimized"); else if (sample.maximized === true) facts.push("maximized");
  }
  const windows = array(record(d.state).windows), apps = array(record(d.state).apps), displays = array(record(d.state).displays);
  if (windows.length || apps.length || displays.length) {
    const [kind, items] = windows.length ? ["window", windows] as const : apps.length ? ["app", apps] as const : ["display", displays] as const;
    facts.push(`${items.length} ${kind}${items.length === 1 ? "" : "s"}`);
    rows.push(...items.map(item => listedRow(kind, record(item), describe)));
  }
  const verification = record(d.verification);
  if (array(verification.conditions).length) {
    const conditions = array(verification.conditions).map(raw => record(raw));
    facts.push(`${conditions.filter(c => c.verdict === "satisfied").length}/${conditions.length} conditions`);
    rows.push(...conditions.map((c, i) => `${i + 1}. ${oneLine(c.verdict ?? "")}${str(c.reason) ? ` — ${oneLine(c.reason, 120)}` : ""}`));
  }
  if (state === "refused" || state === "unknown" || state === "failed") {
    const reason = firstReason(result.content?.find(block => block.type === "text")?.text?.replace(/^<system-result\b[^>]*>[\s\S]*?<\/system-result>\r?\n?/, "").split("\n").slice(1).join("\n"));
    notes.push(...problemNotes(state, {}, reason));
  }
  // A resource with no typed observation fields, such as the session descriptor: its own text is the readable form.
  if (!facts.length && !rows.length && !notes.length && (state === "observed" || state === "listed")) rows.push(...contentRows(result));
  const captured = str(record(d.source).captured_at);
  if (captured) details.push(["captured", captured]);
  const freshness = str(record(record(d.source).visibility).paint_freshness);
  if (freshness) details.push(["paint", freshness]);
  if (str(d.mode)) details.push(["mode", String(d.mode)]);
  return { state, facts, notes, rows, details };
}

function listedRow(kind: "window" | "app" | "display", item: Record<string, unknown>, describe?: DescribeAddress): string {
  void describe;
  if (kind === "window") return [str(item.app_name), str(item.title) ? `“${oneLine(item.title, 70)}”` : undefined, sizeFact(item.bounds), item.owned === true ? "yours" : undefined].filter(Boolean).join("  ");
  if (kind === "app") return oneLine(item.name ?? item.launch_path ?? "");
  return [str(item.display_id) ?? str(item.name), sizeFact(item.bounds), item.primary === true ? "primary" : undefined].filter(Boolean).join("  ");
}

// --- Components Pi mounts ---

const reuse = <T extends Component>(previous: Component | undefined, type: new (...args: never[]) => T): T | undefined => previous instanceof type ? previous : undefined;

/** A heading component, reusing the previous one so a redraw does not flicker. */
export function headingComponent(heading: Heading, theme: Theme, expanded: boolean, previous?: Component): Component {
  const component = reuse(previous, HeadingLine) as HeadingLine | undefined;
  if (component) { component.update(heading, theme, expanded); return component; }
  return new HeadingLine(heading, theme, expanded);
}
/** An outcome component, reusing the previous one. */
export function outcomeComponent(outcome: Outcome, theme: Theme, expanded: boolean, previous?: Component): Component {
  const component = reuse(previous, OutcomeCard) as OutcomeCard | undefined;
  if (component) { component.update(outcome, theme, expanded); return component; }
  return new OutcomeCard(outcome, theme, expanded);
}

/** renderCall and renderResult of one typed computer_* tool. */
export function typedRenderers(tool: string, describe?: DescribeAddress) {
  return {
    renderCall: (args: unknown, theme: Theme, context: RenderContext & { expanded?: boolean }): Component =>
      headingComponent(typedHeading(tool, args, describe), theme, context.expanded === true, context.lastComponent),
    renderResult: (result: ToolResult, options: RenderOptions, theme: Theme, context: RenderContext): Component =>
      outcomeComponent(options.isPartial ? { state: "running" } : actionOutcome(result, context.isError === true, describe), theme, options.expanded, context.lastComponent),
  };
}

/** Pi Agent IDE's Read result renderer for computer addresses. */
export function computerReadRenderer(describe?: DescribeAddress) {
  return (result: ToolResult, options: RenderOptions, theme: Theme, context: RenderContext): Component =>
    outcomeComponent(options.isPartial ? { state: "running" } : readOutcome(result, context.isError === true, describe), theme, options.expanded, context.lastComponent);
}

/** Pi Agent IDE's Search result renderer for computer addresses. Search results carry the listing under `payload`. */
export const computerSearchRenderer = computerReadRenderer;

/** A Write, Insert or Delete on a computer address: refused or closed, with a heading that names the target. */
export function computerActionRenderer(tool: "write" | "insert" | "delete", describe?: DescribeAddress) {
  const owns = (value: unknown) => typeof record(value).path === "string" && String(record(value).path).startsWith("computer:");
  return {
    tool,
    matches: (value: unknown, phase: "call" | "result") => phase === "call" ? owns(value)
      : record(record(record(value).details).metadata).semanticAction !== undefined && record(record(record(record(value).details).metadata).semanticAction).kind === "computer-action",
    renderCall: (args: unknown, theme: Theme, context: RenderContext & { expanded?: boolean }): Component =>
      headingComponent(resourceHeading(tool, args, describe), theme, context.expanded === true, context.lastComponent),
    renderResult: (result: ToolResult, options: RenderOptions, theme: Theme, context: RenderContext): Component =>
      outcomeComponent(options.isPartial ? { state: "running" } : actionOutcome(result, context.isError === true, describe), theme, options.expanded, context.lastComponent),
  };
}

/** renderCall and renderResult of the standalone computer_read / computer_search / computer_delete tools. */
export function resourceRenderers(tool: "computer_read" | "computer_search" | "computer_delete", describe?: DescribeAddress) {
  return {
    renderCall: (args: unknown, theme: Theme, context: RenderContext & { expanded?: boolean }): Component =>
      headingComponent(resourceHeading(tool, args, describe), theme, context.expanded === true, context.lastComponent),
    renderResult: (result: ToolResult, options: RenderOptions, theme: Theme, context: RenderContext): Component =>
      outcomeComponent(options.isPartial ? { state: "running" } : tool === "computer_delete" ? actionOutcome(result, context.isError === true, describe) : readOutcome(result, context.isError === true, describe),
        theme, options.expanded, context.lastComponent),
  };
}
