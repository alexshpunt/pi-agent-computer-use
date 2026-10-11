/** A namespaced computer resource; references are session-issued, never native PIDs. */
export type ComputerAddress =
  | { kind: "session" | "apps" | "windows" | "displays"; source: string }
  | { kind: "app" | "window" | "display" | "sequence"; source: string; ref: string }
  | { kind: "observation"; source: string; ref: string; hint?: string; delivery?: "background" | "foreground"; delayMs?: number };

const directories = new Set(["session", "apps", "windows", "displays"]);
const references = new Set(["app", "window", "display", "observation", "sequence"]);

/** Resolve this namespace or reject malformed owned addresses before any native work. */
export function parseComputerAddress(source: string): ComputerAddress | undefined {
  if (!source.startsWith("computer:")) return undefined;
  const invalid = () => { throw new Error("Invalid computer resource. Use an address returned by Search or Read."); };
  if (source.length > 1024 || source.includes("#") || /[\s\x00-\x1f]/.test(source)) return invalid();
  const [path, query] = source.slice(9).split("?");
  if (source.split("?").length > 2) return invalid();
  const parts = path.split("/");
  const kind = parts[0];
  if (directories.has(kind)) {
    if (parts.length !== 1 || query !== undefined) return invalid();
    return { kind: kind as "session" | "apps" | "windows" | "displays", source };
  }
  if (!references.has(kind) || parts.length !== 2) return invalid();
  let ref: string;
  try { ref = decodeURIComponent(parts[1]); } catch { return invalid(); }
  if (!/^[a-zA-Z0-9_-]{1,160}$/.test(ref)) return invalid();
  if (kind !== "observation") {
    if (query !== undefined) return invalid();
    return { kind: kind as "app" | "window" | "display" | "sequence", ref, source };
  }
  const result: Extract<ComputerAddress, { kind: "observation" }> = { kind, ref, source };
  const params = new URLSearchParams(query);
  const seen = new Set<string>();
  for (const [key, value] of params) {
    if (seen.has(key)) return invalid();
    seen.add(key);
    if (key === "hint" && /^[a-z0-9]+:[a-z]+$/.test(value)) result.hint = value;
    else if (key === "delivery" && (value === "background" || value === "foreground")) result.delivery = value;
    else if (key === "delay_ms" && /^(0|[1-9][0-9]*)$/.test(value) && Number(value) <= 200) result.delayMs = Number(value);
    else return invalid();
  }
  return result;
}

/** Build a computer address from an opaque session-issued reference. */
export function computerSource(kind: "app" | "window" | "display" | "observation" | "sequence", ref: string): string {
  const source = `computer:${kind}/${encodeURIComponent(ref)}`;
  parseComputerAddress(source);
  return source;
}
