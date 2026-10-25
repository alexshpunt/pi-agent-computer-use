import type { UiElement, UiResource } from "./ui-resources.ts";
import type { WebDom } from "./session.ts";
import { diffFrames, pixelsChanged, type PixelBox, type PixelDiff, type PixelFrame } from "./pixel-diff.ts";

/** How a window's overview pixels changed; `crops` are the regions the attached before/after image pairs show, in order. */
export type PixelReport = PixelDiff & { crops?: PixelBox[]; since?: string };

/** Compact change list between an action's input observation and its successor. Bounded; full successors stay readable. */
export interface StateDiff {
  /** What was compared: page lines, UI elements, or only pixels when the earlier observation had no UI. */
  kind: "dom" | "ui" | "pixels";
  /** Lines or elements that changed, appeared or disappeared, at most DIFF_LIMIT each. */
  changed: string[]; added: string[]; removed: string[];
  /** Totals before bounding. */
  counts: { changed: number; added: number; removed: number };
  page?: { url?: [string, string]; title?: [string, string]; tab?: [string | null, string | null] };
  /** Why the diff may be incomplete, such as a partial native walk. */
  note?: string;
  /** How long after the action the native captures kept looking for a change, or waited for the window to settle. */
  waited_ms?: number;
  /** The window's overview pixels compared with the earlier capture; absent when either side had no pixels. */
  pixels?: PixelReport;
  /** Set when the window was still changing when the wait ended; the successor shows it at that moment. */
  unsettled?: true;
}
const DIFF_LIMIT = 30;
const bounded = (items: string[]) => items.slice(0, DIFF_LIMIT);

// Aria refs are snapshot-local names; compare structure without them so a renumbered ref is not a change.
const plainLine = (line: string) => line.replace(/ \[ref=[a-z0-9]+\]/gi, "").replace(/ \[cursor=pointer\]/g, "");

/** Diff two Playwright aria snapshots line by line, plus URL, title and active tab. */
export function diffDom(before: WebDom, after: WebDom): StateDiff {
  const count = (lines: string[]) => lines.reduce((map, line) => map.set(line, (map.get(line) ?? 0) + 1), new Map<string, number>());
  const old = before.snapshot.split("\n").filter(Boolean), next = after.snapshot.split("\n").filter(Boolean);
  const oldCount = count(old.map(plainLine));
  const removed: string[] = [], added: string[] = [];
  const remaining = new Map(oldCount);
  for (const line of next) {
    const key = plainLine(line), left = remaining.get(key) ?? 0;
    if (left > 0) remaining.set(key, left - 1); else added.push(line.trim());
  }
  for (const line of old) {
    const key = plainLine(line), left = remaining.get(key) ?? 0;
    if (left > 0) { removed.push(line.trim()); remaining.set(key, left - 1); }
  }
  const page: StateDiff["page"] = {
    ...(before.url !== after.url ? { url: [before.url, after.url] as [string, string] } : {}),
    ...(before.title !== after.title ? { title: [before.title, after.title] as [string, string] } : {}),
    ...(before.active !== after.active ? { tab: [before.active ?? null, after.active ?? null] as [string | null, string | null] } : {}),
  };
  // A line whose node text before its value stayed the same is one changed element, not a removal plus an addition.
  const node = (line: string) => plainLine(line).replace(/ \[(active|checked|selected|disabled|expanded|pressed)[^\]]*\]/g, "").split(": ")[0];
  const changed: string[] = [];
  for (let i = removed.length - 1; i >= 0; i--) {
    const match = added.findIndex(line => node(line) === node(removed[i]));
    if (match < 0) continue;
    changed.unshift(`${removed[i]} → ${added[match]}`);
    added.splice(match, 1); removed.splice(i, 1);
  }
  return { kind: "dom", changed: bounded(changed), added: bounded(added), removed: bounded(removed), counts: { changed: changed.length, added: added.length, removed: removed.length },
    ...(Object.keys(page).length ? { page } : {}),
    ...(before.truncated || after.truncated ? { note: "A snapshot was truncated; changes beyond its end are not listed." } : {}) };
}

const describe = (element: UiElement) => `${element.role ?? "?"} ${JSON.stringify(element.name ?? "")}`;
/** The compared properties of an element, in a fixed order; values are display strings. */
const properties = (element: UiElement): [string, string][] => [
  ["value", JSON.stringify(element.value && element.value.length > 120 ? element.value.slice(0, 120) + "…" : element.value)],
  ["enabled", String(element.enabled)], ["selected", String(element.selected)],
  ...(element.checked !== undefined ? [["checked", element.checked] as [string, string]] : []),
  ...(element.expanded !== undefined ? [["expanded", String(element.expanded)] as [string, string]] : []),
];
const state = (element: UiElement) => properties(element).map(([key, value]) => `${key}=${value}`).join(" ");
/** Only the properties that differ, so a changed row reads `value="" → "Ada"`, not two full property lists. */
function stateChange(before: UiElement, after: UiElement): string {
  const old = new Map(properties(before)), next = new Map(properties(after));
  return [...new Set([...old.keys(), ...next.keys()])].filter(key => old.get(key) !== next.get(key))
    .map(key => `${key}=${old.get(key) ?? "?"} → ${next.get(key) ?? "?"}`).join(" ");
}

/**
 * Where an element sits, independent of its name: its AutomationId when it has a stable one, otherwise its role,
 * its parent's role and name and its position among same-role siblings. A button renamed from "Count 0" to
 * "Count 1" keeps its place, so it is one changed element, not a removal plus an addition.
 */
function places(elements: readonly UiElement[]): Map<UiElement, string> {
  const byHint = new Map(elements.map(element => [element.hint, element]));
  const ordinals = new Map<string, number>(), out = new Map<UiElement, string>();
  for (const element of elements) {
    const parent = element.parent_hint ? byHint.get(element.parent_hint) : undefined;
    const sibling = `${element.role ?? ""}\u0000${parent ? `${parent.role ?? ""}\u0000${parent.name ?? ""}` : ""}`;
    const ordinal = ordinals.get(sibling) ?? 0;
    ordinals.set(sibling, ordinal + 1);
    out.set(element, element.automation_id && !/^\d+$/.test(element.automation_id) ? `id\u0000${element.role}\u0000${element.automation_id}` : `${sibling}\u0000${ordinal}`);
  }
  return out;
}

/**
 * Diff two native UI walks. Elements match by role and name in order; a duplicate label pairs with the
 * next unmatched element of the same key. Unmatched elements that kept their place are renames. A removal
 * from a partial walk may be truncation, not removal.
 */
export function diffUi(before: UiResource, after: UiResource): StateDiff {
  const key = (element: UiElement) => `${element.role ?? ""}\u0000${element.name ?? ""}`;
  const pool = new Map<string, UiElement[]>();
  for (const element of before.elements) pool.set(key(element), [...(pool.get(key(element)) ?? []), element]);
  const changed: string[] = [], fresh: UiElement[] = [];
  for (const element of after.elements) {
    const previous = pool.get(key(element))?.shift();
    if (!previous) { fresh.push(element); continue; }
    if (state(previous) !== state(element)) changed.push(`${element.hint} ${describe(element)}: ${stateChange(previous, element)}`);
  }
  // Pair what is left by place: the same control under a new name.
  const oldPlaces = places(before.elements), newPlaces = places(after.elements);
  const gone = new Map<string, UiElement>();
  for (const element of [...pool.values()].flat()) gone.set(oldPlaces.get(element)!, element);
  const added: string[] = [];
  for (const element of fresh) {
    const previous = gone.get(newPlaces.get(element)!);
    if (!previous) { added.push(`${element.hint} ${describe(element)} ${state(element)}`); continue; }
    gone.delete(newPlaces.get(element)!);
    const rest = stateChange(previous, element);
    changed.push(`${element.hint} ${element.role ?? "?"} ${JSON.stringify(previous.name ?? "")} → ${JSON.stringify(element.name ?? "")}${rest ? ` ${rest}` : ""}`);
  }
  const removed = [...gone.values()].map(element => `${describe(element)} ${state(element)}`);
  const partial = before.complete !== true || after.complete !== true || before.truncated || after.truncated;
  return { kind: "ui", changed: bounded(changed), added: bounded(added), removed: bounded(removed),
    counts: { changed: changed.length, added: added.length, removed: removed.length },
    ...(partial ? { note: "A native UI walk was partial; listed additions and removals may reflect walk limits, not the app." } : {}) };
}

/** Whether a diff found any difference at all. */
export const diffIsEmpty = (diff: StateDiff): boolean =>
  diff.counts.changed + diff.counts.added + diff.counts.removed === 0 && !Object.keys(diff.page ?? {}).length && !(diff.pixels && pixelsChanged(diff.pixels));

/** One native capture of a window: its UI walk and its decoded overview pixels, either of which may be missing. */
export interface Capture { ui?: UiResource; frame?: PixelFrame }
/** Compare two native captures of a window: UI elements when both have UI, pixels when both have pixels. */
export function compareCaptures(before: Capture, after: Capture): StateDiff | undefined {
  const pixels = before.frame && after.frame ? diffFrames(before.frame, after.frame) : undefined;
  const ui = before.ui && after.ui ? diffUi(before.ui, after.ui) : undefined;
  if (ui) return pixels ? { ...ui, pixels } : ui;
  return pixels ? { kind: "pixels", changed: [], added: [], removed: [], counts: { changed: 0, added: 0, removed: 0 }, pixels } : undefined;
}