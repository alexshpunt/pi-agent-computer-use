import type { UiElement, UiResource } from "./ui-resources.ts";
import type { WebDom } from "./session.ts";

/** Compact change list between an action's input observation and its successor. Bounded; full successors stay readable. */
export interface StateDiff {
  kind: "dom" | "ui";
  /** Lines or elements that changed, appeared or disappeared, at most DIFF_LIMIT each. */
  changed: string[]; added: string[]; removed: string[];
  /** Totals before bounding. */
  counts: { changed: number; added: number; removed: number };
  page?: { url?: [string, string]; title?: [string, string]; tab?: [string | null, string | null] };
  /** Why the diff may be incomplete, such as a partial native walk. */
  note?: string;
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
const state = (element: UiElement) => `value=${JSON.stringify(element.value && element.value.length > 120 ? element.value.slice(0, 120) + "…" : element.value)} enabled=${element.enabled} selected=${element.selected}`;

/**
 * Diff two native UI walks. Elements match by role and name in order; a duplicate label pairs with the
 * next unmatched element of the same key. A removal from a partial walk may be truncation, not removal.
 */
export function diffUi(before: UiResource, after: UiResource): StateDiff {
  const key = (element: UiElement) => `${element.role ?? ""}\u0000${element.name ?? ""}`;
  const pool = new Map<string, UiElement[]>();
  for (const element of before.elements) pool.set(key(element), [...(pool.get(key(element)) ?? []), element]);
  const changed: string[] = [], added: string[] = [];
  for (const element of after.elements) {
    const previous = pool.get(key(element))?.shift();
    if (!previous) { added.push(`${element.hint} ${describe(element)} ${state(element)}`); continue; }
    if (state(previous) !== state(element)) changed.push(`${element.hint} ${describe(element)}: ${state(previous)} → ${state(element)}`);
  }
  const removed = [...pool.values()].flat().map(element => `${describe(element)} ${state(element)}`);
  const partial = before.complete !== true || after.complete !== true || before.truncated || after.truncated;
  return { kind: "ui", changed: bounded(changed), added: bounded(added), removed: bounded(removed),
    counts: { changed: changed.length, added: added.length, removed: removed.length },
    ...(partial ? { note: "A native UI walk was partial; listed additions and removals may reflect walk limits, not the app." } : {}) };
}
