/** A machine's discovery resources: its windows and installed apps (Search) and its displays (Read). */
export type MachinePart = "windows" | "apps" | "displays";
/** A namespaced computer resource; references are session-issued, never native PIDs. */
export type ComputerAddress =
  | { kind: "session"; source: string }
  /** A machine by its name: `local` for this one, otherwise a name under `machines` in .pi/computer-use.json. */
  | { kind: "machine"; source: string; ref: string; part?: MachinePart }
  | { kind: "app" | "window" | "sequence" | "window-state" | "sandbox"; source: string; ref: string }
  /** A display of one machine: `primary`, or a reference listed by that machine's displays. */
  | { kind: "display"; source: string; machine: string; ref: string }
  | { kind: "observation"; source: string; ref: string; hint?: string; delivery?: "background" | "foreground"; delayMs?: number };

const references = new Set(["app", "window", "observation", "sequence", "window-state", "sandbox", "machine"]);
const parts = new Set(["windows", "apps", "displays"]);

/** Resolve this namespace or reject malformed owned addresses before any native work. */
export function parseComputerAddress(source: string): ComputerAddress | undefined {
  if (!source.startsWith("computer:")) return undefined;
  const invalid = () => { throw new Error("Invalid computer resource. Use computer:session, computer:machine/<name> or an address returned by Search or Read."); };
  if (source.length > 1024 || source.includes("#") || /[\s\x00-\x1f]/.test(source)) return invalid();
  const [path, query] = source.slice(9).split("?");
  if (source.split("?").length > 2) return invalid();
  const segments = path.split("/");
  const kind = segments[0];
  if (kind === "session") {
    if (segments.length !== 1 || query !== undefined) return invalid();
    return { kind, source };
  }
  if (kind === "display")
    throw new Error("Display addresses name their machine: computer:machine/<name>/display/primary, or a display listed by Read computer:machine/<name>/displays.");
  const reference = (segment: string) => {
    let ref: string;
    try { ref = decodeURIComponent(segment); } catch { return invalid(); }
    return /^[a-zA-Z0-9_-]{1,160}$/.test(ref) ? ref : invalid();
  };
  if (kind === "machine" && segments.length === 4 && segments[2] === "display") {
    if (query !== undefined) return invalid();
    return { kind: "display", source, machine: reference(segments[1]), ref: reference(segments[3]) };
  }
  const machinePart = kind === "machine" && segments.length === 3 ? segments[2] : undefined;
  if (!references.has(kind) || (segments.length !== 2 && !(machinePart && parts.has(machinePart)))) return invalid();
  const ref = reference(segments[1]);
  if (kind !== "observation") {
    if (query !== undefined) return invalid();
    if (kind === "machine") return { kind, ref, source, ...(machinePart ? { part: machinePart as MachinePart } : {}) };
    return { kind: kind as "app" | "window" | "sequence" | "window-state" | "sandbox", ref, source };
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

/** Build a computer address from an opaque session-issued reference, or a machine's address from its name. */
export function computerSource(kind: "app" | "window" | "observation" | "sequence" | "window-state" | "sandbox" | "machine", ref: string, part?: MachinePart): string {
  const source = `computer:${kind}/${encodeURIComponent(ref)}${part ? `/${part}` : ""}`;
  parseComputerAddress(source);
  return source;
}

/** The address of one machine's display: `primary` or a reference its displays listing issued. */
export function displaySource(machine: string, ref: string): string {
  const source = `computer:machine/${encodeURIComponent(machine)}/display/${encodeURIComponent(ref)}`;
  parseComputerAddress(source);
  return source;
}
