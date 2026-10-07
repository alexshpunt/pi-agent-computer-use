/** Evidence for one attempted action. Delivery is not an app postcondition or a promise about later actions. */
export interface ActionCapability {
  scope: "attempted_action_only";
  basis: "native_receipt";
  operation: string;
  native_tool: string;
  requested_delivery: "background" | "foreground";
  actual_delivery: "background" | "foreground" | "unknown";
  background: "delivered" | "unavailable" | "unknown";
  foreground: "delivered" | "suggested" | "unknown";
  unsupported: boolean;
  route: string | null;
  event_kind: string | null;
  code: string | null;
}

/** Project only explicit native delivery/refusal evidence. Requested mode and toolkit labels prove nothing. */
export function actionCapability(operation: string, nativeTool: string, requested: "background" | "foreground",
  status: "delivered" | "refused" | "unknown", native: Record<string, unknown>): ActionCapability {
  const delivery = native.delivery as { mode?: unknown } | undefined;
  const escalation = native.escalation as { recommended?: unknown } | undefined;
  const actual = delivery?.mode === "background" || delivery?.mode === "foreground" ? delivery.mode : "unknown";
  const code = typeof native.code === "string" ? native.code : null;
  const unavailable = status === "refused" && ["background_unavailable", "background_occluded", "background_uipi_blocked"].includes(code ?? "");
  const delivered = status === "delivered" && !["suspected_noop", "partial", "refused", "unknown"].includes(String(native.effect));
  return { scope: "attempted_action_only", basis: "native_receipt", operation, native_tool: nativeTool,
    requested_delivery: requested, actual_delivery: actual,
    background: unavailable ? "unavailable" : delivered && actual === "background" ? "delivered" : "unknown",
    foreground: delivered && actual === "foreground" ? "delivered" : unavailable && escalation?.recommended === "foreground" ? "suggested" : "unknown",
    unsupported: status === "refused" && ["key_hold_unavailable", "held_path_unavailable"].includes(code ?? ""),
    route: typeof native.route === "string" ? native.route : null,
    event_kind: typeof native.event_kind === "string" ? native.event_kind : null, code };
}
