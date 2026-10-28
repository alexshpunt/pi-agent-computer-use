import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { keyText } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

/**
 * What a person sees of a Computer Use call and its outcome in the native Pi TUI.
 *
 * Everything here is presentation: it reads typed result fields (never the agent's receipt text) and draws them in the
 * conventions of Pi Agent IDE's tool cards, a bold tool title with a primary value and muted qualifiers, and a status
 * line with an icon, so the two kinds of tool read alike. Nothing here changes what the agent receives.
 */

/** The state of a call, as a person reads it. Refused means nothing was sent; unknown means it may have been. */
export type ComputerState = "running" | "observed" | "listed" | "delivered" | "closed" | "refused" | "unknown" | "failed";

const STATES: Record<ComputerState, { icon: string; tone: ThemeColor }> = {
  running: { icon: "●", tone: "accent" },
  observed: { icon: "✓", tone: "success" },
  listed: { icon: "✓", tone: "success" },
  delivered: { icon: "✓", tone: "success" },
  closed: { icon: "✓", tone: "success" },
  refused: { icon: "✗", tone: "warning" },
  unknown: { icon: "?", tone: "warning" },
  failed: { icon: "✗", tone: "error" },
};

/** One styled value of a call heading. */
export interface HeadingPart { text: string; color?: ThemeColor }

/** A call heading: the tool, what it acts on, and the options that matter, most important first. */
export interface Heading {
  tool: string;
  primary?: HeadingPart;
  qualifiers?: readonly string[];
  /** Exact arguments, shown only when the card is expanded. */
  details?: readonly (readonly [label: string, value: string])[];
}

/** A note under the status line. */
export interface Note { tone: ThemeColor; text: string }

/** The outcome of a call, ready to draw. */
export interface Outcome {
  state: ComputerState;
  /** What the status line says after the state: where, on what, how big. */
  facts?: readonly string[];
  /** Why, or what to know, always shown (wrapped). */
  notes?: readonly Note[];
  /** Short rows such as UI elements or listed windows. Compact shows the first few. */
  rows?: readonly string[];
  /** More rows than those given, when the source was already bounded. */
  moreRows?: number;
  /** Labelled facts shown only when expanded. */
  details?: readonly (readonly [label: string, value: string])[];
}

/** Rows and note lines a compact card shows before it offers to expand. */
export const COMPACT_ROWS = 6;
const EXPANDED_ROWS = 40;

/** App text is data, never terminal control sequences. One line, no layout characters. */
export function oneLine(value: unknown, max = 240): string {
  const text = String(value ?? "").replace(/[\x00-\x1f\x7f-\x9f]+/g, " ").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

const separator = (theme: Theme) => theme.fg("dim", " · ");

/** A width-safe tool-call heading: `tool primary · qualifier · qualifier`, dropping qualifiers before it clips the primary. */
export class HeadingLine implements Component {
  constructor(private heading: Heading, private theme: Theme, private expanded: boolean) {}
  update(heading: Heading, theme: Theme, expanded: boolean): void { this.heading = heading; this.theme = theme; this.expanded = expanded; }
  invalidate(): void {}
  render(width: number): string[] {
    const w = Math.max(1, width), theme = this.theme, { tool, primary, details } = this.heading;
    const title = theme.fg("toolTitle", theme.bold(oneLine(tool)));
    let line = title;
    if (primary && visibleWidth(title) < w) {
      const qualifiers = (this.heading.qualifiers ?? []).map(q => oneLine(q)).filter(Boolean);
      const sep = separator(theme), sepWidth = visibleWidth(sep);
      let kept = qualifiers.length;
      const total = () => visibleWidth(title) + 1 + visibleWidth(oneLine(primary.text)) +
        qualifiers.slice(0, kept).reduce((sum, q) => sum + sepWidth + visibleWidth(q), 0) + (kept < qualifiers.length ? sepWidth + 4 : 0);
      while (kept > 0 && total() > w) kept--;
      const shown = qualifiers.slice(0, kept).map(q => `${sep}${theme.fg("muted", q)}`).join("");
      // The "… +N" marker is worth its room only when the target fits whole beside it.
      const more = kept < qualifiers.length && total() <= w ? `${sep}${theme.fg("dim", `… +${qualifiers.length - kept}`)}` : "";
      const room = Math.max(1, w - visibleWidth(title) - 1 - visibleWidth(shown) - visibleWidth(more));
      line = `${title} ${theme.fg(primary.color ?? "accent", truncateToWidth(oneLine(primary.text), room))}${shown}${more}`;
    }
    const lines = [truncateToWidth(line, w)];
    if (this.expanded && details?.length) {
      const text = [theme.fg("dim", "args ")].concat(details.map(([label, value], i) =>
        `${i === 0 ? "" : theme.fg("dim", " · ")}${theme.fg("muted", `${oneLine(label)}=`)}${theme.fg("toolOutput", oneLine(value))}`)).join("");
      lines.push(...wrapTextWithAnsi(text, w).map(l => truncateToWidth(l, w)));
    }
    return lines;
  }
}

/** The outcome of a call below its heading: a status line, notes, and a few rows that expand on demand. */
export class OutcomeCard implements Component {
  constructor(private outcome: Outcome, private theme: Theme, private expanded: boolean) {}
  update(outcome: Outcome, theme: Theme, expanded: boolean): void { this.outcome = outcome; this.theme = theme; this.expanded = expanded; }
  invalidate(): void {}
  render(width: number): string[] {
    const w = Math.max(1, width), theme = this.theme, { state, facts = [], notes = [], rows = [], moreRows = 0, details = [] } = this.outcome;
    const { icon, tone } = STATES[state];
    const status = theme.fg(tone, `${icon} ${state}`);
    const line = [status, ...facts.filter(Boolean).map(f => theme.fg("muted", oneLine(f)))].join(separator(theme));
    const lines = [truncateToWidth(line, w)];
    const indent = "  ", inner = Math.max(1, w - indent.length);
    for (const note of notes) for (const part of wrapTextWithAnsi(theme.fg(note.tone, oneLine(note.text, 600)), inner)) lines.push(indent + truncateToWidth(part, inner));
    const limit = this.expanded ? EXPANDED_ROWS : COMPACT_ROWS;
    for (const row of rows.slice(0, limit)) lines.push(indent + truncateToWidth(theme.fg("dim", oneLine(row, 400)), inner));
    const hidden = Math.max(0, rows.length - limit) + moreRows;
    if (this.expanded) {
      for (const [label, value] of details) lines.push(indent + truncateToWidth(`${theme.fg("muted", `${oneLine(label)} `)}${theme.fg("toolOutput", oneLine(value, 400))}`, inner));
      if (hidden > 0) lines.push(indent + truncateToWidth(theme.fg("muted", `… ${hidden} more`), inner));
    } else if (hidden > 0) {
      lines.push(indent + truncateToWidth(theme.fg("muted", `… ${hidden} more · ${keyText("app.tools.expand")} to expand`), inner));
    }
    return lines;
  }
}

// --- Reading typed result fields. Anything absent or of another type is simply not shown. ---

export const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const str = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value : undefined;
const num = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) ? value : undefined;

/** The opening of a message for a status note: its first line, up to two sentences. */
export function firstReason(message: unknown, max = 220): string | undefined {
  const text = str(message);
  if (!text) return undefined;
  const meaningful = text.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith("{") && !l.startsWith("}"));
  // A header that ends in a colon ("Validation failed for tool x:") is only worth showing with the line it introduces.
  const first = meaningful[0] ?? text;
  const line = oneLine(first.endsWith(":") && meaningful[1] ? `${first} ${meaningful[1].replace(/^-\s*/, "")}` : first, 2000);
  const sentences = line.split(/(?<=[.!?])\s+/);
  let reason = sentences[0];
  if (sentences[1] && reason.length + sentences[1].length < max) reason += ` ${sentences[1]}`;
  return oneLine(reason, max);
}

/** Names for what an address points at, supplied by the live session; absent for an address from an earlier run. */
export type DescribeAddress = (source: string) => { machine?: string; title?: string } | undefined;

/** The machine and window title an address names in this run, for display. */
export function targetNames(describe: DescribeAddress | undefined, source: unknown): { machine?: string; title?: string } {
  const address = str(source);
  const named = address ? describe?.(address) : undefined;
  return { ...(named?.machine ? { machine: named.machine } : {}), ...(named?.title ? { title: `“${oneLine(named.title, 60)}”` } : {}) };
}

/** The state of a typed action from its semantic data. */
export function actionState(data: Record<string, unknown>, isError: boolean): ComputerState {
  const status = str(data.status);
  if (status === "delivered" || status === "observed" || status === "listed" || status === "closed" || status === "unknown" || status === "refused") {
    // A delivered receipt that the adapter still marked not ok (a failed postcondition) is not a success.
    return data.ok === false && status !== "unknown" && status !== "refused" ? "unknown" : status;
  }
  if (data.ok === true && !isError) return "delivered";
  if (data.effect === "not-applied") return "refused";
  if (data.effect === "unknown") return "unknown";
  return isError ? "failed" : "delivered";
}

/** Notes for a refused, unknown or failed action: the reason in a person's terms, and what to do not do. */
export function problemNotes(state: ComputerState, data: Record<string, unknown>, fallback?: string): Note[] {
  if (state !== "refused" && state !== "unknown" && state !== "failed") return [];
  const script = record(data.script), error = record(data.error);
  const reason = firstReason(script.reason) ?? firstReason(error.message) ?? fallback;
  const notes: Note[] = [];
  if (reason) notes.push({ tone: state === "failed" ? "error" : "warning", text: reason });
  if (state === "unknown") notes.push({ tone: "muted", text: "It may have been applied. Read the window before acting again; do not repeat it blindly." });
  return notes;
}

/** What changed in the UI after an action, from the successor observation's diff. */
export function successorNotes(successor: unknown): { notes: Note[]; rows: string[] } {
  const diff = record(record(successor).diff);
  if (!Object.keys(diff).length) return { notes: [], rows: [] };
  const counts = record(diff.counts), changed = num(counts.changed) ?? 0, added = num(counts.added) ?? 0, removed = num(counts.removed) ?? 0;
  const waited = num(diff.waited_ms);
  const what = diff.kind === "dom" ? "page" : diff.kind === "pixels" ? "pixels" : "UI";
  if (changed + added + removed === 0) {
    const pixels = record(diff.pixels);
    return { notes: [{ tone: "warning", text: `Nothing changed in the ${what}${waited !== undefined ? ` within ${waited} ms` : ""}. Check the target before acting again.${pixels.changed === true ? "" : ""}` }], rows: [] };
  }
  const parts = [changed && `${changed} changed`, added && `${added} added`, removed && `${removed} removed`].filter(Boolean).join(", ");
  const rows = [...array(diff.changed).map(l => `~ ${oneLine(l, 160)}`), ...array(diff.added).map(l => `+ ${oneLine(l, 160)}`), ...array(diff.removed).map(l => `- ${oneLine(l, 160)}`)];
  return { notes: [{ tone: "muted", text: `${what} ${parts}${waited !== undefined ? ` within ${waited} ms` : ""}` }], rows };
}

/** `500×350` from a width and height. */
export const size = (width: unknown, height: unknown): string | undefined => num(width) !== undefined && num(height) !== undefined ? `${width}×${height}` : undefined;

/** UI element rows `hint  role  name`; values are left out, they can be typed text or secrets. */
export function elementRows(elements: unknown): string[] {
  return array(elements).map(raw => {
    const e = record(raw);
    return [str(e.hint), str(e.role), str(e.name) ? `“${oneLine(e.name, 80)}”` : undefined, e.enabled === false ? "(disabled)" : undefined].filter(Boolean).join("  ");
  }).filter(Boolean);
}
