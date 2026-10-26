import { isSemanticAction } from "./semantic-actions.ts";
import { isCoordinateScroll } from "./scroll-actions.ts";

/** Complete CUA operations. None exposes a key or button held between calls. */
export interface InputCommand {
  action: "move" | "hover" | "invoke" | "select" | "type_text" | "set_value" | "click" | "right_click" | "double_click" | "scroll" | "drag" | "select_all" | "key" | "hotkey" | "hold" | "timeline" | "menu";
  element_token?: string;
  /** Snapshot-scoped UI alias; ComputerSession resolves it before native validation. */
  hint?: string;
  x?: number; y?: number;
  text?: string; key?: string; keys?: string[]; modifiers?: string[];
  /** Required bounded native dwell for hover; move sends no dwell. */
  dwell_ms?: number;
  delay_ms?: number;
  button?: "left" | "right" | "middle";
  direction?: "up" | "down" | "left" | "right";
  amount?: number; by?: "line" | "page";
  /** Signed native wheel detents at a pixel point; positive values scroll content right/down. */
  delta_x?: number; delta_y?: number;
  /** Coordinate scroll only; one detent is 120 native wheel-delta units, not a content distance. */
  unit?: "wheel_detents";
  from_x?: number; from_y?: number; to_x?: number; to_y?: number;
  duration_ms?: number; steps?: number;
  /** Intermediate local screenshot points in one Windows left-button stroke. */
  via?: { x: number; y: number }[];
  /** Complete screenshot-grounded pointer steps executed while this command owns its held keys. */
  actions?: HoldPointer[];
  /** Timed key, button, motion, wheel and pen events; everything still held is released when the call ends. */
  events?: TimelineEvent[];
  /** Menu labels from the top-level menu to the item, resolved and invoked through accessibility. */
  path?: string[];
}
/** One event of an input timeline, at_ms after its start. Points are overview pixels; move_relative is raw mouse motion. */
export interface TimelineEvent {
  at_ms: number;
  type: "key_down" | "key_up" | "button_down" | "button_up" | "move" | "move_relative" | "wheel" | "pen_down" | "pen_move" | "pen_up";
  key?: string; button?: "left" | "right" | "middle" | "x1" | "x2";
  x?: number; y?: number; dx?: number; dy?: number;
  /** Pen only: pressure 0..1, tilt -90..90 degrees, eraser end, barrel button. */
  pressure?: number; tilt_x?: number; tilt_y?: number; eraser?: boolean; barrel?: boolean;
}
/** Longest timeline, in requested time and events, that one call accepts. */
export const TIMELINE_MAX_MS = 120_000;
export const TIMELINE_MAX_EVENTS = 5000;
/** Pointer input inside one bounded key hold; only observed local pixels, no nested key state. */
export type HoldPointer = Pick<InputCommand, "x" | "y" | "from_x" | "from_y" | "to_x" | "to_y" | "duration_ms" | "steps" | "via"> & { action: "click" | "drag" };
/** Wait before a complete step, measured from the previous step's completion. */
export interface InputStep extends InputCommand { wait_ms?: number }

const modifiers = ["ctrl", "shift", "alt", "win"];
const fields: Record<InputCommand["action"], string[]> = {
  move: [], hover: ["dwell_ms"],
  key: ["key", "modifiers"], hotkey: ["keys"], type_text: ["text", "delay_ms"], set_value: ["text"],
  click: ["button", "modifiers"], right_click: ["modifiers"], double_click: ["modifiers"],
  scroll: ["direction", "amount", "by", "delta_x", "delta_y", "unit"], drag: ["from_x", "from_y", "to_x", "to_y", "duration_ms", "steps", "button", "modifiers", "via"],
  select_all: [], invoke: [], select: [],
  hold: ["keys", "duration_ms", "actions"],
  timeline: ["events"],
  menu: ["path"],
};
/** Common key spellings mapped to the driver's names; matching ignores case. */
const KEY_ALIASES: Record<string, string> = { enter: "return", esc: "escape", del: "delete", spacebar: "space", pgup: "pageup", pgdn: "pagedown",
  arrowup: "up", arrowdown: "down", arrowleft: "left", arrowright: "right", control: "ctrl", windows: "win", meta: "win", option: "alt",
  minus: "-", hyphen: "-", equals: "=", comma: ",", period: ".", dot: ".", slash: "/", backslash: "\\", semicolon: ";", quote: "'", apostrophe: "'",
  backtick: "`", grave: "`", bracketleft: "[", bracketright: "]" };
const canonicalKey = (key: unknown) => typeof key === "string" ? KEY_ALIASES[key.toLowerCase()] ?? key.toLowerCase() : key;
const KEY_NAMES = "a-z, 0-9, the unshifted punctuation - = [ ] ; ' , . / \\ ` (or minus, comma, period...), return (Enter), tab, escape, space, backspace, delete, up, down, left, right, home, end, pageup, pagedown or f1-f12; hold shift for shifted characters, or type text";
const validKey = (key: unknown): key is string => typeof key === "string" && /^(?:[a-z0-9\-=[\];',./\\`]|return|tab|escape|space|backspace|delete|up|down|left|right|home|end|pageup|pagedown|f[1-9]|f1[0-2])$/.test(key);
const integer = (value: unknown, min: number, max: number) => Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;

/** Complete steps a sequence may contain; each releases its keys and buttons before the next starts. */
const SEQUENCE_ACTIONS: readonly string[] = ["key", "hotkey", "type_text", "select_all", "drag", "click", "double_click", "right_click"];
/** Validate complete commands against the original window overview before any member of a batch runs. */
export function validateInput(command: InputStep, observed: { tokens: Set<string>; width?: number; height?: number }, sequence = false): void {
  if (!command || !fields[command.action]) throw new Error("Unsupported complete action.");
  if (command.key !== undefined) command.key = canonicalKey(command.key) as string;
  if (Array.isArray(command.keys)) command.keys = command.keys.map(canonicalKey) as string[];
  if (Array.isArray(command.modifiers)) command.modifiers = command.modifiers.map(canonicalKey) as string[];
  const allowed = new Set(["action", ...fields[command.action], ...(isSemanticAction(command.action) ? ["element_token"] : ["drag", "hold", "timeline", "menu"].includes(command.action) ? [] : ["element_token", "x", "y"]), ...(sequence ? ["wait_ms"] : [])]);
  if (Object.keys(command).some(key => !allowed.has(key))) throw new Error("This action has unsupported or conflicting fields.");
  if (sequence && !SEQUENCE_ACTIONS.includes(command.action)) throw new Error(`Sequences accept only complete keyboard actions, clicks and drags: ${SEQUENCE_ACTIONS.join(", ")}.`);
  if (command.action === "hold") {
    if (!Array.isArray(command.keys) || command.keys.length < 1 || command.keys.length > 8 || new Set(command.keys).size !== command.keys.length || command.keys.some(key => !validKey(key) && !modifiers.includes(key))) throw new Error("hold needs 1..8 unique ordinary keys or modifiers.");
    if (!integer(command.duration_ms, 1, 10000)) throw new Error("hold duration_ms must be 1..10000.");
    if (command.actions !== undefined) {
      if (!Array.isArray(command.actions) || command.actions.length < 1 || command.actions.length > 32) throw new Error("hold actions must contain 1..32 complete pointer steps.");
      let requested = 0;
      for (const action of command.actions) {
        const allowed = action?.action === "click" ? ["action", "x", "y"] : ["action", "from_x", "from_y", "to_x", "to_y", "duration_ms", "steps", "via"];
        if (!action || !["click", "drag"].includes(action.action) || Object.keys(action).some(key => !allowed.includes(key))) throw new Error("hold accepts only pixel left clicks/drags without extra modifiers.");
        validateInput(action, observed);
        requested += action.action === "click" ? 50 : action.duration_ms ?? 500;
      }
      if (requested > command.duration_ms!) throw new Error("Pointer steps exceed the hold duration.");
    }
  }
  if (command.wait_ms !== undefined && !integer(command.wait_ms, 0, 5000)) throw new Error("wait_ms must be 0..5000.");
  const point = (x: unknown, y: unknown) => {
    if (!Number.isFinite(x) || !Number.isFinite(y) || (x as number) < 0 || (y as number) < 0 || !observed.width || !observed.height || (x as number) >= observed.width || (y as number) >= observed.height)
      throw new Error("Use coordinates inside the current scoped window screenshot.");
  };
  if (command.element_token !== undefined && !observed.tokens.has(command.element_token)) throw new Error("Element token is not in this window's current observation.");
  const pixel = command.x !== undefined || command.y !== undefined;
  if (pixel) { if (command.element_token !== undefined) throw new Error("Choose a token or a point, not both."); point(command.x, command.y); }
  if (["move", "hover", "click", "right_click", "double_click", "scroll"].includes(command.action) && !command.element_token && !pixel) throw new Error("This pointer action needs an observed token or point.");
  if (command.action === "hover" && !integer(command.dwell_ms, 1, 10000)) throw new Error("hover needs dwell_ms from 1 to 10000.");
  if (["type_text", "set_value"].includes(command.action) && (typeof command.text !== "string" || command.text.length > 2000)) throw new Error("This action needs text, at most 2000 characters.");
  if (isSemanticAction(command.action) && !command.element_token) throw new Error("Semantic actions need an observed token.");
  if (command.action === "key" && !validKey(command.key)) throw new Error(`Unsupported key ${JSON.stringify(command.key)}. Use ${KEY_NAMES}.`);
  if (command.modifiers !== undefined && (!Array.isArray(command.modifiers) || command.modifiers.length > 4 || new Set(command.modifiers).size !== command.modifiers.length || command.modifiers.some(value => !modifiers.includes(value)))) throw new Error("Use unique ctrl/shift/alt/win modifiers.");
  if (command.action === "hotkey") {
    const keys = command.keys;
    if (!Array.isArray(keys) || keys.length < 2 || keys.length > 5 || new Set(keys).size !== keys.length || keys.slice(0, -1).some(key => !modifiers.includes(key)) || !validKey(keys.at(-1))) throw new Error("hotkey needs unique modifiers followed by one key.");
  }
  if (command.delay_ms !== undefined && !integer(command.delay_ms, 0, 200)) throw new Error("delay_ms must be 0..200.");
  if (command.button !== undefined && !["left", "right", "middle"].includes(command.button)) throw new Error("Unsupported button.");
  if (command.action === "scroll") {
    if (pixel) {
      if (command.direction !== undefined || command.amount !== undefined || command.by !== undefined) throw new Error("Coordinate scroll cannot combine detents with direction, amount or by.");
      if (command.unit !== "wheel_detents") throw new Error("Coordinate scroll requires unit: wheel_detents; displacement is controlled by the app.");
      const dx = command.delta_x === undefined ? 0 : command.delta_x, dy = command.delta_y === undefined ? 0 : command.delta_y;
      if (!integer(dx, -50, 50) || !integer(dy, -50, 50) || (dx === 0 && dy === 0)) throw new Error("Coordinate scroll needs integer deltas in -50..50 detents and at least one nonzero axis.");
    } else {
      if (command.delta_x !== undefined || command.delta_y !== undefined || command.unit !== undefined) throw new Error("Wheel detents require a point in the current window overview.");
      if (!command.element_token) throw new Error("Accessibility scroll requires an observed element_token.");
      if (!["up", "down", "left", "right"].includes(command.direction ?? "")) throw new Error("Unsupported scroll direction.");
      if (command.amount !== undefined && !integer(command.amount, 1, 50)) throw new Error("amount must be 1..50.");
      if (command.by !== undefined && !["line", "page"].includes(command.by)) throw new Error("Scroll by line or page.");
    }
  }
  if (command.action === "timeline") validateTimeline(command.events, point);
  if (command.action === "menu" && (!Array.isArray(command.path) || command.path.length < 1 || command.path.length > 16 || command.path.some(label => typeof label !== "string" || !label.trim() || label.length > 200)))
    throw new Error("menu needs path: 1..16 menu labels from the top-level menu to the item.");
  if (command.action === "drag") {
    point(command.from_x, command.from_y); point(command.to_x, command.to_y);
    if (command.duration_ms !== undefined && !integer(command.duration_ms, 0, 10000)) throw new Error("duration_ms must be 0..10000.");
    if (command.steps !== undefined && !integer(command.steps, 1, 200)) throw new Error("steps must be 1..200.");
    if (command.via !== undefined) {
      if (!Array.isArray(command.via) || command.via.length < 1 || command.via.length > 254 || command.steps !== undefined || command.modifiers !== undefined || (command.button !== undefined && command.button !== "left"))
        throw new Error("via needs 1..254 points, left button, and no steps or modifiers.");
      for (const p of command.via) {
        if (!p || typeof p !== "object" || Array.isArray(p) || Object.keys(p).some(key => !["x", "y"].includes(key))) throw new Error("Each via point needs only x and y.");
        point(p.x, p.y);
      }
    }
  }
}

/** Estimated requested native gesture time, excluding transport/admission and OS scheduling. */
export function requestedInputTime(command: InputStep): number {
  return (command.wait_ms ?? 0) + (command.action === "hold" ? command.duration_ms ?? 0 : command.action === "drag" ? command.duration_ms ?? 500 : command.action === "type_text" ? (command.text?.length ?? 0) * (command.delay_ms ?? 30)
    : command.action === "timeline" ? command.events?.at(-1)?.at_ms ?? 0 : 0);
}

const TIMELINE_FIELDS: Record<TimelineEvent["type"], string[]> = {
  key_down: ["key"], key_up: ["key"], button_down: ["button"], button_up: ["button"], move: ["x", "y"], move_relative: ["dx", "dy"], wheel: ["dx", "dy"],
  pen_down: ["x", "y", "pressure", "tilt_x", "tilt_y", "eraser", "barrel"], pen_move: ["x", "y", "pressure", "tilt_x", "tilt_y", "eraser", "barrel"], pen_up: ["x", "y", "pressure", "tilt_x", "tilt_y", "eraser", "barrel"],
};
/** Check a timeline completely before any input: order, fields, overview points and balanced presses. */
function validateTimeline(events: unknown, point: (x: unknown, y: unknown) => void): void {
  if (!Array.isArray(events) || events.length < 1 || events.length > TIMELINE_MAX_EVENTS) throw new Error(`timeline needs 1..${TIMELINE_MAX_EVENTS} events.`);
  let last = 0; const keys = new Set<string>(), buttons = new Set<string>(); let pen = false;
  for (const raw of events as TimelineEvent[]) {
    if (!raw || typeof raw !== "object" || !TIMELINE_FIELDS[raw.type]) throw new Error("Each timeline event needs a supported type.");
    if (Object.keys(raw).some(key => key !== "at_ms" && key !== "type" && !TIMELINE_FIELDS[raw.type].includes(key))) throw new Error(`A ${raw.type} event has unsupported fields.`);
    if (!integer(raw.at_ms, last, TIMELINE_MAX_MS)) throw new Error(`Timeline at_ms must be non-decreasing integers up to ${TIMELINE_MAX_MS}.`);
    last = raw.at_ms;
    switch (raw.type) {
      case "key_down": case "key_up":
        raw.key = canonicalKey(raw.key) as string;
        if (!validKey(raw.key) && !modifiers.includes(String(raw.key))) throw new Error("Unsupported timeline key.");
        if (raw.type === "key_down" ? keys.has(raw.key!) : !keys.has(raw.key!)) throw new Error(`Timeline key ${raw.key} is ${raw.type === "key_down" ? "already down" : "not down"}.`);
        raw.type === "key_down" ? keys.add(raw.key!) : keys.delete(raw.key!);
        break;
      case "button_down": case "button_up": {
        const button = raw.button ?? "left";
        if (!["left", "right", "middle", "x1", "x2"].includes(button)) throw new Error("Unsupported timeline button.");
        if (raw.type === "button_down" ? buttons.has(button) : !buttons.has(button)) throw new Error(`Timeline button ${button} is ${raw.type === "button_down" ? "already down" : "not down"}.`);
        raw.type === "button_down" ? buttons.add(button) : buttons.delete(button);
        break;
      }
      case "move_relative":
        if (!integer(raw.dx, -10000, 10000) || !integer(raw.dy, -10000, 10000)) throw new Error("move_relative needs integer dx and dy in -10000..10000.");
        break;
      case "wheel": {
        const dx = raw.dx ?? 0, dy = raw.dy ?? 0;
        if (!integer(dx, -50, 50) || !integer(dy, -50, 50) || (dx === 0 && dy === 0)) throw new Error("wheel needs integer dx/dy detents in -50..50, at least one nonzero.");
        break;
      }
      default:
        point(raw.x, raw.y);
        if (raw.type !== "move") {
          if (raw.pressure !== undefined && !(Number.isFinite(raw.pressure) && raw.pressure >= 0 && raw.pressure <= 1)) throw new Error("Pen pressure must be 0..1.");
          for (const tilt of [raw.tilt_x, raw.tilt_y]) if (tilt !== undefined && !integer(tilt, -90, 90)) throw new Error("Pen tilt must be an integer -90..90.");
          if (raw.type === "pen_down" ? pen : raw.type === "pen_up" && !pen) throw new Error(`The pen is ${pen ? "already" : "not"} down.`);
          if (raw.type === "pen_down") pen = true; else if (raw.type === "pen_up") pen = false;
        }
    }
  }
}

/** Translate supported fields only. Coordinates stay in the original overview's local image domain.
 * captureBoundDrag enables straight-drag binding only for a separately qualified native runtime. */
export function nativeInput(command: InputCommand, target: { pid: number; window_id: number }, delivery: string, captureId?: string, captureBoundDrag = false, uiaOnly = false): { name: string; args: Record<string, unknown> } {
  if (isCoordinateScroll(command)) return { name: "scroll_at", args: {
    ...target, capture_id: captureId, x: command.x, y: command.y,
    delta_x: command.delta_x ?? 0, delta_y: command.delta_y ?? 0, unit: command.unit, delivery_mode: delivery,
  } };
  if (command.action === "move" || command.action === "hover") return { name: "move_pointer", args: {
    ...target, delivery_mode: delivery, dwell_ms: command.action === "hover" ? command.dwell_ms : 0,
    ...(command.element_token !== undefined ? { element_token: command.element_token } : { capture_id: captureId, x: command.x, y: command.y }),
  } };
  if (command.action === "timeline") return { name: "input_timeline", args: { ...target, events: command.events, delivery_mode: delivery } };
  if (command.action === "menu") return { name: "invoke_menu", args: { ...target, path: command.path } };
  if (isSemanticAction(command.action)) return { name: "semantic_action", args: { ...target, element_token: command.element_token,
    operation: command.action, ...(command.action === "set_value" ? { value: command.text } : {}) } };
  const name = command.action === "hold" ? "hold_keys" : command.action === "select_all" ? "hotkey" : command.action === "key" ? "press_key" : command.action;
  const args: Record<string, unknown> = { delivery_mode: delivery, ...((["right_click", "double_click", "hold"].includes(command.action) || command.via !== undefined) ? target : { target: { kind: "window", ...target } }) };
  for (const key of ["element_token", "x", "y", ...fields[command.action]]) {
    const value = command[key as keyof InputCommand];
    if (value !== undefined) args[key === "modifiers" ? command.action === "key" ? "modifiers" : "modifier" : key] = value;
  }
  if (command.action === "select_all") args.keys = ["ctrl", "a"];
  // UI Automation only: an element click or scroll that no pattern carries is refused by the driver, never posted.
  if (uiaOnly) {
    if (args.element_token === undefined || !["click", "scroll"].includes(name)) throw new Error("uia_only takes a click or scroll on an element token.");
    args.uia_only = true;
  }
  if (captureId && ((command.action === "click" && command.x !== undefined) || (captureBoundDrag && command.action === "drag" && command.via === undefined))) args.capture_id = captureId;
  return { name, args };
}
