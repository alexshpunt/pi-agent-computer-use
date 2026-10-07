import { Type } from "@earendil-works/pi-ai";

/** Complete CUA operations. None exposes a key or button held between calls. */
export interface InputCommand {
  action: "type_text" | "set_value" | "click" | "right_click" | "double_click" | "scroll" | "drag" | "select_all" | "key" | "hotkey" | "hold";
  element_token?: string;
  /** Snapshot-scoped UI alias; ComputerSession resolves it before native validation. */
  hint?: string;
  x?: number; y?: number;
  text?: string; key?: string; keys?: string[]; modifiers?: string[];
  delay_ms?: number;
  button?: "left" | "right" | "middle";
  direction?: "up" | "down" | "left" | "right";
  amount?: number; by?: "line" | "page";
  from_x?: number; from_y?: number; to_x?: number; to_y?: number;
  duration_ms?: number; steps?: number;
  /** Intermediate local screenshot points in one Windows left-button stroke. */
  via?: { x: number; y: number }[];
  /** Complete screenshot-grounded pointer steps executed while this command owns its held keys. */
  actions?: HoldPointer[];
}
/** Pointer input inside one bounded key hold; only observed local pixels, no nested key state. */
export type HoldPointer = Pick<InputCommand, "x" | "y" | "from_x" | "from_y" | "to_x" | "to_y" | "duration_ms" | "steps" | "via"> & { action: "click" | "drag" };
/** Wait before a complete step, measured from the previous step's completion. */
export interface InputStep extends InputCommand { wait_ms?: number }

const names = ["type_text", "set_value", "click", "right_click", "double_click", "scroll", "drag", "select_all", "key", "hotkey", "hold"] as const;
const modifiers = ["ctrl", "shift", "alt", "win"];
const enumSchema = (values: readonly string[]) => Type.Union(values.map(value => Type.Literal(value)));
const optional = {
  hint: Type.Optional(Type.String({ minLength: 1, description: "Short alias from this exact observation; cannot combine with element_token or pixels." })),
  element_token: Type.Optional(Type.String({ minLength: 1 })),
  x: Type.Optional(Type.Number({ minimum: 0 })), y: Type.Optional(Type.Number({ minimum: 0 })),
  text: Type.Optional(Type.String({ maxLength: 2000 })),
  key: Type.Optional(Type.String({ minLength: 1, description: "Complete key: letter/digit, return, tab, escape, space, backspace, delete, arrows, home/end, pageup/pagedown or f1..f12." })),
  keys: Type.Optional(Type.Array(Type.String(), { minItems: 1, maxItems: 8, uniqueItems: true, description: "hotkey: modifiers followed by one key. hold: 1..8 simultaneous ordinary keys or ctrl/shift/alt/win, released within this call." })),
  modifiers: Type.Optional(Type.Array(enumSchema(modifiers), { maxItems: 4, uniqueItems: true })),
  delay_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: 200, description: "type_text only: CUA's per-character delay; default 30." })),
  button: Type.Optional(enumSchema(["left", "right", "middle"])),
  direction: Type.Optional(enumSchema(["up", "down", "left", "right"])),
  amount: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
  by: Type.Optional(enumSchema(["line", "page"])),
  from_x: Type.Optional(Type.Number({ minimum: 0 })), from_y: Type.Optional(Type.Number({ minimum: 0 })),
  to_x: Type.Optional(Type.Number({ minimum: 0 })), to_y: Type.Optional(Type.Number({ minimum: 0 })),
  duration_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: 10000 })),
  steps: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
  via: Type.Optional(Type.Array(Type.Object({ x: Type.Number({ minimum: 0 }), y: Type.Number({ minimum: 0 }) },
    { additionalProperties: false }), { minItems: 1, maxItems: 254,
    description: "drag only: intermediate window-local points for one held left-button stroke. Requires the qualified Windows fork and explicit foreground; no steps or modifiers." })),
};
/** Schema for the existing computer_act surface; semantic validation also runs before native input. */
export const actionParameters = Type.Object({
  window_ref: Type.String({ minLength: 1 }), observation_id: Type.String({ minLength: 1 }),
  action: enumSchema([...names, "sequence"]),
  delivery_mode: Type.Optional(enumSchema(["background", "foreground"])),
  animation: Type.Optional(Type.Literal("reactive", { description: "Use configured minimal CUA cursor animation for this action only, then restore ordinary animation. Native click pauses stay unchanged." })),
  actions: Type.Optional(Type.Array(Type.Object({
    action: enumSchema(["click", "drag"]),
    ...Object.fromEntries(["x", "y", "from_x", "from_y", "to_x", "to_y", "duration_ms", "steps", "via"].map(key => [key, optional[key as keyof typeof optional]])),
  }, { additionalProperties: false }), { minItems: 1, maxItems: 32,
    description: "hold only: complete left clicks/drags inside this key hold. Pixel targets from this overview; total pointer time must fit duration_ms. No tokens, modifiers or nested holds." })),
  ...optional,
  sequence: Type.Optional(Type.Array(Type.Object({
    action: enumSchema(["key", "hotkey", "type_text", "select_all", "drag"]), ...optional,
    wait_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: 5000 })),
  }, { additionalProperties: false }), { minItems: 1, maxItems: 32,
    description: "Known-target keyboard/stroke steps. Each drag releases the button. Up to 30s requested waits/typing/drags; no nested sequence or pointer clicks." })),
}, { additionalProperties: false });

const fields: Record<InputCommand["action"], string[]> = {
  key: ["key", "modifiers"], hotkey: ["keys"], type_text: ["text", "delay_ms"], set_value: ["text"],
  click: ["button", "modifiers"], right_click: ["modifiers"], double_click: ["modifiers"],
  scroll: ["direction", "amount", "by"], drag: ["from_x", "from_y", "to_x", "to_y", "duration_ms", "steps", "button", "modifiers", "via"],
  select_all: [],
  hold: ["keys", "duration_ms", "actions"],
};
const validKey = (key: unknown): key is string => typeof key === "string" && /^(?:[a-z0-9]|return|tab|escape|space|backspace|delete|up|down|left|right|home|end|pageup|pagedown|f[1-9]|f1[0-2])$/.test(key);
const integer = (value: unknown, min: number, max: number) => Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;

/** Validate complete commands against the original window overview before any member of a batch runs. */
export function validateInput(command: InputStep, observed: { tokens: Set<string>; width?: number; height?: number }, sequence = false): void {
  if (!command || !fields[command.action]) throw new Error("Unsupported complete action.");
  const allowed = new Set(["action", ...fields[command.action], ...(["drag", "hold"].includes(command.action) ? [] : ["element_token", "x", "y"]), ...(sequence ? ["wait_ms"] : [])]);
  if (Object.keys(command).some(key => !allowed.has(key))) throw new Error("This action has unsupported or conflicting fields.");
  if (sequence && !["key", "hotkey", "type_text", "select_all", "drag"].includes(command.action)) throw new Error("Sequences accept only complete keyboard actions and drags.");
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
  if (["click", "right_click", "double_click", "scroll"].includes(command.action) && !command.element_token && !pixel) throw new Error("This pointer action needs an observed token or point.");
  if (["type_text", "set_value"].includes(command.action) && (typeof command.text !== "string" || command.text.length > 2000)) throw new Error("This action needs text, at most 2000 characters.");
  if (command.action === "set_value" && !command.element_token) throw new Error("set_value needs an observed token.");
  if (command.action === "key" && !validKey(command.key)) throw new Error("Unsupported key.");
  if (command.modifiers !== undefined && (!Array.isArray(command.modifiers) || command.modifiers.length > 4 || new Set(command.modifiers).size !== command.modifiers.length || command.modifiers.some(value => !modifiers.includes(value)))) throw new Error("Use unique ctrl/shift/alt/win modifiers.");
  if (command.action === "hotkey") {
    const keys = command.keys;
    if (!Array.isArray(keys) || keys.length < 2 || keys.length > 5 || new Set(keys).size !== keys.length || keys.slice(0, -1).some(key => !modifiers.includes(key)) || !validKey(keys.at(-1))) throw new Error("hotkey needs unique modifiers followed by one key.");
  }
  if (command.delay_ms !== undefined && !integer(command.delay_ms, 0, 200)) throw new Error("delay_ms must be 0..200.");
  if (command.button !== undefined && !["left", "right", "middle"].includes(command.button)) throw new Error("Unsupported button.");
  if (command.action === "scroll") {
    if (!command.element_token || pixel) throw new Error("scroll requires an observed element_token; CUA 0.33.2 pixel scroll does not map resized screenshots correctly.");
    if (!["up", "down", "left", "right"].includes(command.direction ?? "")) throw new Error("Unsupported scroll direction.");
    if (command.amount !== undefined && !integer(command.amount, 1, 50)) throw new Error("amount must be 1..50.");
    if (command.by !== undefined && !["line", "page"].includes(command.by)) throw new Error("Scroll by line or page.");
  }
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
  return (command.wait_ms ?? 0) + (command.action === "hold" ? command.duration_ms ?? 0 : command.action === "drag" ? command.duration_ms ?? 500 : command.action === "type_text" ? (command.text?.length ?? 0) * (command.delay_ms ?? 30) : 0);
}

/** Translate supported fields only. Coordinates stay in the original overview's local image domain.
 * captureBoundDrag enables straight-drag binding only for a separately qualified native runtime. */
export function nativeInput(command: InputCommand, target: { pid: number; window_id: number }, delivery: string, captureId?: string, captureBoundDrag = false): { name: string; args: Record<string, unknown> } {
  const name = command.action === "hold" ? "hold_keys" : command.action === "select_all" ? "hotkey" : command.action === "key" ? "press_key" : command.action;
  const args: Record<string, unknown> = { delivery_mode: delivery, ...((["set_value", "right_click", "double_click", "hold"].includes(command.action) || command.via !== undefined) ? target : { target: { kind: "window", ...target } }) };
  for (const key of ["element_token", "x", "y", ...fields[command.action]]) {
    const value = command[key as keyof InputCommand];
    if (value !== undefined) args[key === "modifiers" ? command.action === "key" ? "modifiers" : "modifier" : key === "text" && command.action === "set_value" ? "value" : key] = value;
  }
  if (command.action === "select_all") args.keys = ["ctrl", "a"];
  if (captureId && ((command.action === "click" && command.x !== undefined) || (captureBoundDrag && command.action === "drag" && command.via === undefined))) args.capture_id = captureId;
  return { name, args };
}
