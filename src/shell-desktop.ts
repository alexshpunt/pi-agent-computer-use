/** Independent documented Windows shell queries. The sample is not capture readiness or input authority. */
export type ShellDesktop = { status: "unknown"; reason: "not_reported" | "invalid_native_metadata" } | {
  status: "sampled";
  desktop_id: string | null;
  on_current_desktop: boolean | null;
  desktop_id_error: ShellDesktopError | null;
  on_current_desktop_error: ShellDesktopError | null;
  sampled_at_unix_ms: number;
};
/** Native query failure, not an inferred desktop. HRESULT is a signed Windows error when available. */
export interface ShellDesktopError { code: string; hresult: number | null }
const codes = new Set(["com_initialization_failed", "manager_unavailable", "window_unavailable", "desktop_id_query_failed",
  "current_desktop_query_failed", "invalid_desktop_id", "query_worker_failed"]);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const guid = (value: unknown): value is string => typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) && value !== "00000000-0000-0000-0000-000000000000";
const error = (value: unknown): value is ShellDesktopError => object(value) && typeof value.code === "string" && codes.has(value.code) &&
  (value.hresult === null || (Number.isInteger(value.hresult) && (value.hresult as number) >= -2147483648 && (value.hresult as number) <= 2147483647));

/** Validate native membership without probing Windows or guessing missing fields. Missing and invalid records stay distinct. */
export function shellDesktop(value: unknown): ShellDesktop {
  if (value === undefined) return { status: "unknown", reason: "not_reported" };
  if (!object(value) || !Number.isSafeInteger(value.sampled_at_unix_ms) || (value.sampled_at_unix_ms as number) < 0 ||
    !(guid(value.desktop_id) ? value.desktop_id_error === null : value.desktop_id === null && error(value.desktop_id_error)) ||
    !(typeof value.on_current_desktop === "boolean" ? value.on_current_desktop_error === null : value.on_current_desktop === null && error(value.on_current_desktop_error)))
    return { status: "unknown", reason: "invalid_native_metadata" };
  return { status: "sampled", desktop_id: value.desktop_id as string | null, on_current_desktop: value.on_current_desktop as boolean | null,
    desktop_id_error: value.desktop_id_error === null ? null : { code: (value.desktop_id_error as ShellDesktopError).code, hresult: (value.desktop_id_error as ShellDesktopError).hresult },
    on_current_desktop_error: value.on_current_desktop_error === null ? null : { code: (value.on_current_desktop_error as ShellDesktopError).code, hresult: (value.on_current_desktop_error as ShellDesktopError).hresult },
    sampled_at_unix_ms: value.sampled_at_unix_ms as number };
}
