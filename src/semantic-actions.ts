/** Explicit native UIA intents. These never use the physical action ladder. */
export type SemanticAction = "invoke" | "select" | "set_value";
/** Whether an action requires the separately qualified strict semantic runtime. */
export function isSemanticAction(action: string): action is SemanticAction {
  return ["invoke", "select", "set_value"].includes(action);
}
/** A provider completion receipt is valid only for the exact intent and native pattern. It proves no app/focus postcondition. */
export function semanticReceipt(action: SemanticAction, native: Record<string, unknown>): boolean {
  const patterns = action === "invoke" ? ["invoke"] : action === "select" ? ["selection_item"] : ["value", "range_value"];
  return native.operation === action && patterns.includes(String(native.pattern)) && native.route === "accessibility" &&
    native.effect === "unverifiable" && native.fallback !== true && (native.delivery as { mode?: unknown } | undefined)?.mode === "background";
}
