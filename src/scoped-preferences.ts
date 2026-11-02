import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { lock } from "proper-lockfile";

/** Preferences users can set independently at global and project level. */
export interface ScopedValues {
  mode: "safe" | "yolo";
  escape: boolean;
  cap: number;
  scale: number;
  hints: boolean;
  grid: boolean;
  action: boolean;
  preset: "off" | "subtle" | "full";
  observations: boolean;
  previews: boolean;
  pointer: boolean;
  scroll_drag: boolean;
  keyboard: boolean;
  typed_text: boolean;
  reduced_motion: boolean;
  quality: "performance" | "balanced" | "high";
  opacity: number;
}
export type PreferenceKey = keyof ScopedValues;
export type PreferenceScope = "global" | "project";
export type Preferences = Partial<ScopedValues>;
export interface ScopedPreferences {
  global: Preferences;
  project: Preferences;
  effective: Preferences;
  sources: Partial<Record<PreferenceKey, PreferenceScope>>;
}

const booleanKeys = new Set(["escape", "hints", "grid", "action", "observations", "previews", "pointer", "scroll_drag", "keyboard", "typed_text", "reduced_motion"]);
function valid(key: string, value: unknown): boolean {
  if (booleanKeys.has(key)) return typeof value === "boolean";
  switch (key) {
    case "mode": return value === "safe" || value === "yolo";
    case "preset": return value === "off" || value === "subtle" || value === "full";
    case "quality": return value === "performance" || value === "balanced" || value === "high";
    case "cap": return typeof value === "number" && Number.isSafeInteger(value) && value >= 64 && value <= 4096;
    case "scale": return typeof value === "number" && Number.isFinite(value) && value >= 0.05 && value <= 1;
    case "opacity": return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
    default: return false;
  }
}
function fileFor(cwd: string, scope: PreferenceScope): string {
  return path.join(scope === "global" ? getAgentDir() : path.join(cwd, ".pi"), "computer-use-settings.json");
}
async function readFileSettings(file: string): Promise<Preferences> {
  let raw: unknown;
  try { raw = JSON.parse(await readFile(file, "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`Cannot read Computer Use settings at ${file}.`, { cause: error });
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.entries(raw).some(([key, value]) => !valid(key, value)))
    throw new Error(`Invalid Computer Use settings at ${file}.`);
  return raw as Preferences;
}

/** Read only trusted project overrides; defaults are applied by each consumer. */
export async function readScopedPreferences(cwd: string, trusted = true): Promise<ScopedPreferences> {
  const [global, project] = await Promise.all([
    readFileSettings(fileFor(cwd, "global")),
    trusted ? readFileSettings(fileFor(cwd, "project")) : Promise.resolve({} as Preferences),
  ]);
  const effective = { ...global, ...project };
  const sources: ScopedPreferences["sources"] = {};
  for (const key of Object.keys(global) as PreferenceKey[]) sources[key] = "global";
  for (const key of Object.keys(project) as PreferenceKey[]) sources[key] = "project";
  return { global, project, effective, sources };
}

/** Write one preference without replacing other keys. Undefined clears that override. */
export async function writeScopedPreference<K extends PreferenceKey>(cwd: string, scope: PreferenceScope, key: K, value: ScopedValues[K] | undefined): Promise<void> {
  if (scope !== "global" && scope !== "project") throw new Error("Invalid preference scope.");
  if (value === undefined ? !valid(key, sampleValue(key)) : !valid(key, value)) throw new Error(`Invalid Computer Use setting: ${key}.`);
  const file = fileFor(cwd, scope);
  const dir = path.dirname(file);
  await mkdir(dir, { recursive: true });
  const release = await lock(file, { realpath: false, retries: { retries: 40, factor: 1.2, minTimeout: 10, maxTimeout: 100 } });
  try {
    const settings = await readFileSettings(file);
    if (value === undefined) delete settings[key];
    else settings[key] = value;
    const mode = await stat(file).then(info => info.mode & 0o777).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return 0o600; throw error; });
    const temp = path.join(dir, `.computer-use-settings-${randomUUID()}.tmp`);
    try {
      await writeFile(temp, `${JSON.stringify(settings, null, 2)}\n`, { mode, flag: "wx" });
      await rename(temp, file);
    } finally {
      await unlink(temp).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
    }
  } finally { await release(); }
}

function sampleValue(key: string): unknown {
  if (booleanKeys.has(key)) return false;
  switch (key) {
    case "mode": return "safe";
    case "preset": return "off";
    case "quality": return "balanced";
    case "cap": return 64;
    case "scale": return 1;
    case "opacity": return 0;
    default: return undefined;
  }
}
