import type { UiResource } from "./ui-resources.ts";
import { validateWebTarget, type WebTarget } from "./web-browser.ts";
import { checkedState, isVisible, nativeAriaSnapshot, nativeAriaTree, nativeSelector, queryNative, type ParsedSelector } from "./native-locator.ts";
import { matchesAriaTemplate, parseAriaTemplate } from "./aria-match.ts";

/** Three-valued verdict. `unknown` means the evidence cannot decide, never a hidden `false`. */
export type Verdict = "satisfied" | "unsatisfied" | "unknown";
/** Element state checked by a condition. A state the native runtime does not report is unknown, never false. */
export type ElementState = "exists" | "absent" | "visible" | "hidden" | "enabled" | "disabled" | "selected" | "checked" | "unchecked" | "focused";

/**
 * One condition. `target` is a Playwright locator string or the JSON target; native windows evaluate it over
 * the UIA tree with Playwright's semantics. `value` and `contains` compare the element's value (or text).
 */
export interface UiCondition {
  target?: WebTarget;
  /** The native target as Playwright's parsed selector. */
  selector?: ParsedSelector;
  is?: ElementState;
  value?: string;
  contains?: string;
  /** Like toHaveCount: exactly this many elements match the target. */
  count?: number;
  /** Like toMatchAriaSnapshot: a Playwright aria snapshot template the target's subtree (or the whole window or page) contains. */
  aria?: string;
  /** Page conditions for browser windows. */
  url_contains?: string;
  title?: string;
}
/** A bounded wait: every condition must hold for `stable` consecutive samples before `timeout_ms`. */
export interface WaitSpec { conditions: UiCondition[]; timeout_ms: number; interval_ms: number; stable: number }
export interface ConditionResult { index: number; verdict: Verdict; observed?: string | null; reason?: string }
export interface WaitResult {
  verdict: Verdict; conditions: ConditionResult[]; samples: number; elapsed_ms: number; timed_out: boolean; reason?: string;
}

const STATES: readonly ElementState[] = ["exists", "absent", "visible", "hidden", "enabled", "disabled", "selected", "checked", "unchecked", "focused"];
const NATIVE_STATES: readonly ElementState[] = ["exists", "absent", "visible", "hidden", "enabled", "disabled", "selected", "checked", "unchecked", "focused"];

const integer = (value: unknown, min: number, max: number, fallback: number, what: string): number => {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw Error(`${what} must be an integer ${min}..${max}.`);
  return value as number;
};

/** Validate a wait_for/verify command. `verify` takes one sample; `browser` admits Playwright targets and page conditions. */
export function validateWait(command: Record<string, unknown>, browser: boolean): WaitSpec {
  const verify = command.action === "verify";
  const allowed = ["action", "conditions", ...(verify ? [] : ["timeout_ms", "interval_ms", "stable"])];
  const extra = Object.keys(command).filter(key => !allowed.includes(key));
  if (extra.length) throw Error(`${command.action} does not accept: ${extra.join(", ")}.`);
  if (!Array.isArray(command.conditions) || command.conditions.length < 1 || command.conditions.length > 16) throw Error("conditions must list 1..16 conditions.");
  const conditions = command.conditions.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw Error(`conditions[${index}] must be an object.`);
    const value = raw as Record<string, unknown>;
    const fields = ["target", "is", "value", "contains", "count", "aria", ...(browser ? ["url_contains", "title"] : [])];
    const unknown = Object.keys(value).filter(key => !fields.includes(key));
    if (unknown.length) throw Error(`conditions[${index}] does not accept: ${unknown.join(", ")}.`);
    const condition: UiCondition = {};
    if (value.is !== undefined) {
      if (!(browser ? STATES : NATIVE_STATES).includes(value.is as ElementState))
        throw Error(`conditions[${index}].is must be one of ${(browser ? STATES : NATIVE_STATES).join(", ")}${browser ? "" : " for native windows"}.`);
      condition.is = value.is as ElementState;
    }
    for (const key of ["value", "contains", "url_contains", "title"] as const)
      if (value[key] !== undefined) {
        if (typeof value[key] !== "string" || (value[key] as string).length > 2000) throw Error(`conditions[${index}].${key} must be a string of at most 2000 characters.`);
        condition[key] = value[key] as string;
      }
    if (value.count !== undefined) condition.count = integer(value.count, 0, 10_000, 0, `conditions[${index}].count`);
    if (value.aria !== undefined) {
      if (typeof value.aria !== "string" || !value.aria.trim() || value.aria.length > 20_000) throw Error(`conditions[${index}].aria must be a YAML aria snapshot of at most 20000 characters.`);
      try { parseAriaTemplate(value.aria); } catch (error) { throw Error(`conditions[${index}].aria is not a valid aria snapshot: ${error instanceof Error ? error.message : error}`); }
      condition.aria = value.aria;
    }
    if (value.target !== undefined) {
      if (browser) condition.target = validateWebTarget(value.target);
      // Native targets keep their source form for reports; the parsed selector is what evaluates.
      else { condition.selector = nativeSelector(value.target, `conditions[${index}].target`); condition.target = value.target as WebTarget; }
    }
    const checks = [condition.is, condition.value, condition.contains, condition.count, condition.aria].filter(item => item !== undefined).length;
    if (checks > 1) throw Error(`conditions[${index}] takes one of is, value, contains, count or aria; use separate conditions for several checks.`);
    const elementCheck = checks === 1;
    const pageCheck = condition.url_contains !== undefined || condition.title !== undefined;
    const targeted = condition.target !== undefined || condition.selector !== undefined;
    // aria without a target checks the whole window or page, like expect(page.locator("body")).toMatchAriaSnapshot.
    if (elementCheck === pageCheck || (elementCheck && !targeted && condition.aria === undefined) || (pageCheck && targeted))
      throw Error(`conditions[${index}] needs a target with is/value/contains/count, aria with or without a target, or a page check (url_contains/title) without a target.`);
    return condition;
  });
  const timeout = verify ? 0 : integer(command.timeout_ms, 0, 60_000, 5_000, "timeout_ms");
  return { conditions, timeout_ms: timeout, interval_ms: verify ? 0 : integer(command.interval_ms, 50, 5_000, 250, "interval_ms"),
    stable: verify ? 1 : integer(command.stable, 1, 10, 1, "stable") };
}

/** Combine per-condition verdicts: any unsatisfied decides; otherwise any unknown keeps the whole unknown. */
export function combine(results: readonly ConditionResult[]): Verdict {
  return results.some(r => r.verdict === "unsatisfied") ? "unsatisfied" : results.some(r => r.verdict === "unknown") ? "unknown" : "satisfied";
}

/**
 * Evaluate native conditions against one bounded UI walk. Absence is decided only when the walk is
 * complete and untruncated; otherwise a missing element is `unknown`. Several matches are ambiguous.
 */
export function evaluateNative(ui: UiResource, conditions: readonly UiCondition[], texts?: ReadonlyMap<string, string>): ConditionResult[] {
  const complete = ui.complete === true && !ui.truncated;
  return conditions.map((condition, index) => {
    if (condition.aria !== undefined && !condition.selector) return ariaVerdict(index, ui, condition.aria, complete);
    const found = queryNative(ui, condition.selector!);
    // Like toHaveCount: more matches than wanted are proven; fewer or equal only in a complete walk.
    if (condition.count !== undefined) {
      const observed = `${found.length} match(es)`;
      if (found.length > condition.count) return { index, verdict: "unsatisfied", observed };
      return complete ? { index, verdict: found.length === condition.count ? "satisfied" : "unsatisfied", observed }
        : { index, verdict: "unknown", observed, reason: "The UI walk was incomplete; more elements may match beyond it." };
    }
    // Like Playwright's toBeHidden: no matching element, or one that is not visible.
    if (condition.is === "hidden") {
      if (found.length > 1) return { index, verdict: "unknown", reason: `${found.length} elements match; narrow the target.` };
      if (found.length === 1) return { index, verdict: isVisible(found[0]) ? "unsatisfied" : "satisfied", observed: isVisible(found[0]) ? "visible" : "offscreen" };
      return complete ? { index, verdict: "satisfied", observed: "no match" } : { index, verdict: "unknown", reason: "No match in an incomplete UI walk; the element may exist beyond it." };
    }
    if (condition.is === "absent")
      return found.length ? { index, verdict: "unsatisfied", observed: `${found.length} match(es)` }
        : complete ? { index, verdict: "satisfied", observed: "no match" }
        : { index, verdict: "unknown", reason: "No match in an incomplete UI walk; absence cannot be proven." };
    if (!found.length) return complete ? { index, verdict: "unsatisfied", observed: "no match" }
      : { index, verdict: "unknown", reason: "No match in an incomplete UI walk; the element may exist beyond it." };
    if (found.length > 1) return { index, verdict: "unknown", reason: `${found.length} elements match; narrow the target.` };
    const element = found[0];
    if (condition.aria !== undefined) return ariaVerdict(index, ui, condition.aria, complete, element);
    // A walk cuts texts at 1024 characters; the same capture keeps longer ones in `texts`.
    const full = texts?.get(element.hint);
    const observed = full ?? element.value ?? element.name;
    const known = (flag: boolean | null, want: boolean): ConditionResult => flag === null
      ? { index, verdict: "unknown", reason: "The native UI does not report this state." }
      : { index, verdict: flag === want ? "satisfied" : "unsatisfied", observed: String(flag) };
    if (condition.is === "enabled") return known(element.enabled, true);
    if (condition.is === "disabled") return known(element.enabled, false);
    if (condition.is === "selected") return known(element.selected, true);
    if (condition.is === "visible") return { index, verdict: isVisible(element) ? "satisfied" : "unsatisfied", observed: isVisible(element) ? "visible" : "offscreen" };
    if (condition.is === "checked" || condition.is === "unchecked") {
      const state = checkedState(element);
      return state === null ? { index, verdict: "unknown", reason: "The native UI reports no checked state for this element." }
        : { index, verdict: (state === true) === (condition.is === "checked") && state !== "mixed" ? "satisfied" : "unsatisfied", observed: String(state) };
    }
    if (condition.is === "focused") return known(element.focused ?? null, true);
    if (condition.value !== undefined || condition.contains !== undefined) {
      if (observed === null) return { index, verdict: "unknown", reason: "The element reports no value or name." };
      if (element.text_truncated && full === undefined) return { index, verdict: "unknown", observed, reason: "The element text was truncated at 1024 characters." };
      const ok = condition.value !== undefined ? observed === condition.value : observed.includes(condition.contains!);
      return { index, verdict: ok ? "satisfied" : "unsatisfied", observed: observed.length > 500 ? observed.slice(0, 500) + "…" : observed };
    }
    return { index, verdict: "satisfied", observed: observed && observed.length > 500 ? observed.slice(0, 500) + "…" : observed };
  });
}

/**
 * Like toMatchAriaSnapshot: the template must match inside the element's subtree, or the whole window without a
 * target. A match is proven by any walk; a mismatch only by a complete one. A mismatch shows the received snapshot.
 */
function ariaVerdict(index: number, ui: UiResource, template: string, complete: boolean, root?: UiResource["elements"][number]): ConditionResult {
  if (matchesAriaTemplate(nativeAriaTree(ui, root), template)) return { index, verdict: "satisfied", observed: "matches" };
  const received = nativeAriaSnapshot(ui, root);
  const observed = received.length > 4000 ? received.slice(0, 4000) + "\n…" : received;
  return complete ? { index, verdict: "unsatisfied", observed }
    : { index, verdict: "unknown", observed, reason: "No match in an incomplete UI walk; the rest of the tree may hold it." };
}