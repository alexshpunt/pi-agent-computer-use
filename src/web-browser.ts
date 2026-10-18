import { spawn, execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const WINDOWS_NODE = "/mnt/c/Program Files/nodejs/node.exe";

/** An element chosen by Playwright: an aria ref from the latest DOM snapshot, or locator predicates that must all match. */
export interface WebTarget {
  ref?: string; role?: string; name?: string; label?: string; text?: string; placeholder?: string; test_id?: string; css?: string;
  exact?: boolean;
  /** CSS selectors of nested iframes, outermost first. Refs already carry their frame. */
  frames?: string[];
}
/** Options for a fresh Playwright aria snapshot in "ai" mode. */
export interface WebSnapshotOptions { target?: WebTarget; boxes?: boolean; depth?: number }
/** One Playwright action. Delivery is not proof of the application's response. */
export interface WebAction {
  action: "click" | "hover" | "fill" | "type" | "press" | "check" | "uncheck" | "select" | "focus" | "scroll" | "wait" | "navigate";
  target?: WebTarget;
  button?: "left" | "right" | "middle"; click_count?: number;
  text?: string; key?: string; values?: string[];
  delta_x?: number; delta_y?: number;
  state?: "visible" | "hidden" | "attached" | "detached";
  url?: string; timeout_ms?: number;
}
/** Installed browser channel launched by Playwright. */
export type WebChannel = "chrome" | "msedge";
export interface WebLaunchOptions { browser?: WebChannel; url?: string }
/** Page state returned with every snapshot or action. */
export interface WebPage { url: string; title: string; snapshot: string }
export interface WebOpened { pid: number; version: string; url: string; title: string }
/** Starts one owned browser; the session binds its native window. */
export type WebLauncher = (options: WebLaunchOptions, signal?: AbortSignal) => Promise<{ browser: WebBrowser; opened: WebOpened }>;

/** A Playwright or transport failure. `timeout` and `transport` mean an action may still have reached the page. */
export class WebError extends Error {
  constructor(message: string, readonly timeout = false, readonly transport = false) { super(message); }
}

const record = (value: unknown, what: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error(`${what} must be a JSON object.`);
  return value as Record<string, unknown>;
};
const only = (value: Record<string, unknown>, allowed: readonly string[], what: string) => {
  const extra = Object.keys(value).filter(key => !allowed.includes(key));
  if (extra.length) throw Error(`${what} does not accept: ${extra.join(", ")}.`);
};
const text = (value: unknown, what: string, max = 512): string => {
  if (typeof value !== "string" || !value || value.length > max) throw Error(`${what} must be a non-empty string of at most ${max} characters.`);
  return value;
};
const integer = (value: unknown, min: number, max: number, what: string): number => {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw Error(`${what} must be an integer ${min}..${max}.`);
  return value as number;
};
function httpUrl(value: unknown): string {
  const url = text(value, "url", 4096);
  const parsed = URL.canParse(url) ? new URL(url) : undefined;
  if (!parsed || !["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password)
    throw Error("url must be HTTP(S) without embedded credentials.");
  return url;
}

const PREDICATES = ["role", "name", "label", "text", "placeholder", "test_id", "css"] as const;
/** Check target shape only; Playwright resolves, waits for and disambiguates the element. */
export function validateWebTarget(value: unknown): WebTarget {
  const target = record(value, "target");
  only(target, ["ref", ...PREDICATES, "exact", "frames"], "target");
  if (target.ref !== undefined) {
    if (Object.keys(target).length !== 1 || !/^[a-z0-9]{1,32}$/i.test(String(target.ref)))
      throw Error("target.ref must be an aria ref such as e12 or f1e3, alone.");
    return { ref: target.ref as string };
  }
  const result: WebTarget = {};
  for (const key of PREDICATES) if (target[key] !== undefined) result[key] = text(target[key], `target.${key}`);
  if (!Object.keys(result).length) throw Error("target needs ref or at least one of role, label, text, placeholder, test_id, css.");
  if (result.name !== undefined && result.role === undefined) throw Error("target.name requires target.role.");
  if (target.exact !== undefined) {
    if (typeof target.exact !== "boolean") throw Error("target.exact must be boolean.");
    result.exact = target.exact;
  }
  if (target.frames !== undefined) {
    if (!Array.isArray(target.frames) || target.frames.length < 1 || target.frames.length > 8) throw Error("target.frames must list 1..8 iframe selectors.");
    result.frames = target.frames.map((frame, index) => text(frame, `target.frames[${index}]`));
  }
  return result;
}

/** Validate a `dom` or `dom:{...}` Read view. */
export function validateWebSnapshot(value: unknown = {}): WebSnapshotOptions {
  const options = record(value, "dom options");
  only(options, ["target", "boxes", "depth"], "dom options");
  if (options.boxes !== undefined && typeof options.boxes !== "boolean") throw Error("boxes must be boolean.");
  return { ...(options.target !== undefined ? { target: validateWebTarget(options.target) } : {}),
    ...(options.boxes !== undefined ? { boxes: options.boxes as boolean } : {}),
    ...(options.depth !== undefined ? { depth: integer(options.depth, 1, 64, "depth") } : {}) };
}

const ACTIONS: Record<WebAction["action"], { fields: readonly string[]; target: "required" | "optional" | "none" }> = {
  click: { fields: ["button", "click_count"], target: "required" },
  hover: { fields: [], target: "required" },
  fill: { fields: ["text"], target: "required" },
  type: { fields: ["text"], target: "required" },
  press: { fields: ["key"], target: "optional" },
  check: { fields: [], target: "required" },
  uncheck: { fields: [], target: "required" },
  select: { fields: ["values"], target: "required" },
  focus: { fields: [], target: "required" },
  scroll: { fields: ["delta_x", "delta_y"], target: "optional" },
  wait: { fields: ["state"], target: "required" },
  navigate: { fields: ["url"], target: "none" },
};
/** Validate one Insert command on a DOM observation before anything reaches the browser. */
export function validateWebAction(value: unknown): WebAction {
  const command = record(value, "DOM action");
  const name = command.action as WebAction["action"];
  const spec = Object.hasOwn(ACTIONS, String(name)) ? ACTIONS[name] : undefined;
  if (!spec) throw Error(`action must be one of ${Object.keys(ACTIONS).join(", ")}.`);
  only(command, ["action", "timeout_ms", ...spec.fields, ...(spec.target === "none" ? [] : ["target"])], `${name}`);
  const action: WebAction = { action: name };
  if (command.target !== undefined) action.target = validateWebTarget(command.target);
  else if (spec.target === "required") throw Error(`${name} needs a target.`);
  if (command.timeout_ms !== undefined) action.timeout_ms = integer(command.timeout_ms, 1, 60_000, "timeout_ms");
  if (command.button !== undefined) {
    if (!["left", "right", "middle"].includes(command.button as string)) throw Error("button must be left, right or middle.");
    action.button = command.button as WebAction["button"];
  }
  if (command.click_count !== undefined) action.click_count = integer(command.click_count, 1, 3, "click_count");
  if (name === "fill" || name === "type") {
    if (typeof command.text !== "string" || command.text.length > 20_000) throw Error(`${name} needs text of at most 20000 characters.`);
    action.text = command.text;
  }
  if (name === "press") action.key = text(command.key, "key", 64);
  if (name === "select") {
    if (!Array.isArray(command.values) || command.values.length < 1 || command.values.length > 64) throw Error("select needs 1..64 values.");
    action.values = command.values.map((option, index) => text(option, `values[${index}]`));
  }
  if (name === "scroll") {
    for (const axis of ["delta_x", "delta_y"] as const) {
      const delta = command[axis];
      if (delta === undefined) continue;
      if (typeof delta !== "number" || !Number.isFinite(delta) || Math.abs(delta) > 20_000) throw Error(`${axis} must be a number within ±20000.`);
      action[axis] = delta;
    }
    if (action.delta_x === undefined && action.delta_y === undefined) throw Error("scroll needs delta_x or delta_y.");
  }
  if (name === "wait") {
    const state = command.state ?? "visible";
    if (!["visible", "hidden", "attached", "detached"].includes(state as string)) throw Error("state must be visible, hidden, attached or detached.");
    action.state = state as WebAction["state"];
  }
  if (name === "navigate") action.url = httpUrl(command.url);
  return action;
}

/** Validate an `open_browser` command. */
export function validateWebLaunch(value: Record<string, unknown>): WebLaunchOptions {
  only(value, ["action", "browser", "url"], "open_browser");
  if (value.browser !== undefined && !["chrome", "msedge"].includes(value.browser as string)) throw Error("browser must be chrome or msedge.");
  return { ...(value.browser !== undefined ? { browser: value.browser as WebChannel } : {}),
    ...(value.url !== undefined ? { url: httpUrl(value.url) } : {}) };
}

interface Pending { resolve(value: unknown): void; reject(error: Error): void }

/**
 * One Windows Node worker that owns one visible Playwright browser and its disposable profile.
 * Ending the worker's stdin closes that browser and deletes the profile.
 */
export class WebBrowser {
  private readonly pending = new Map<number, Pending>();
  private serial = 0;
  private buffer = "";
  private stderr = "";
  private readonly exited: Promise<void>;
  private alive = true;

  private constructor(private readonly child: ChildProcessWithoutNullStreams) {
    this.exited = new Promise(resolve => child.once("close", () => {
      this.alive = false;
      this.fail(new WebError(`Browser worker exited. ${this.stderr.trim()}`.trim(), false, true));
      resolve();
    }));
    child.on("error", error => this.fail(new WebError(error.message, false, true)));
    child.stdin.on("error", error => this.fail(new WebError(error.message, false, true)));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", chunk => { this.stderr = (this.stderr + chunk).slice(-4000); });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      this.buffer += chunk;
      let end: number;
      while ((end = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 1);
        let response: { id?: number; value?: unknown; error?: { name?: string; message?: string } };
        try { response = JSON.parse(line); }
        catch { this.fail(new WebError("Browser worker wrote an invalid response.", false, true)); child.kill(); return; }
        const request = this.pending.get(response.id!);
        if (!request) continue;
        this.pending.delete(response.id!);
        if (response.error) request.reject(new WebError(String(response.error.message ?? "Browser operation failed."), response.error.name === "TimeoutError"));
        else request.resolve(response.value);
      }
    });
  }

  /** Spawn the worker with Windows Node (directly on Windows, through interop from WSL) and open the browser. */
  static async launch(options: WebLaunchOptions & { interop?: string }, signal?: AbortSignal): Promise<{ browser: WebBrowser; opened: WebOpened }> {
    let command = process.execPath;
    let worker = fileURLToPath(new URL("./web-worker.ts", import.meta.url));
    if (process.platform === "linux") {
      command = WINDOWS_NODE;
      worker = (await run("wslpath", ["-w", worker], { timeout: 5000 })).stdout.trim();
    } else if (process.platform !== "win32") throw new WebError("The Playwright browser backend runs only on Windows or WSL.");
    signal?.throwIfAborted();
    const child = spawn(command, ["--disable-warning=ExperimentalWarning", worker], {
      stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
      env: { ...process.env, ...(options.interop ? { WSL_INTEROP: options.interop } : {}) },
    });
    const browser = new WebBrowser(child);
    try {
      const opened = await browser.request<WebOpened>("open", { browser: options.browser ?? "chrome", ...(options.url ? { url: options.url } : {}) }, signal, 60_000);
      if (!Number.isSafeInteger(opened.pid) || opened.pid <= 0) throw new WebError("Browser launch did not report a process id.");
      return { browser, opened };
    } catch (error) {
      await browser.close().catch(() => undefined);
      throw error;
    }
  }

  private fail(error: Error): void {
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }

  /** Send one operation. Cancellation stops waiting; an operation already sent may still complete in the browser. */
  request<T>(op: string, args: object = {}, signal?: AbortSignal, timeoutMs = 90_000): Promise<T> {
    if (signal?.aborted) return Promise.reject(new WebError("Cancelled before the browser received the request."));
    if (!this.alive) return Promise.reject(new WebError("The browser worker is gone. Open a new browser."));
    const id = ++this.serial;
    return new Promise<T>((resolve, reject) => {
      const lost = (message: string) => { this.pending.delete(id); reject(new WebError(message, false, true)); };
      const abort = () => lost("Cancelled after the browser received the request; it may still complete.");
      const timer = setTimeout(() => lost("The browser worker did not answer in time; the request may still complete."), timeoutMs);
      const settle = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
      this.pending.set(id, { resolve: value => { settle(); resolve(value as T); }, reject: error => { settle(); reject(error); } });
      signal?.addEventListener("abort", abort, { once: true });
      this.child.stdin.write(JSON.stringify({ id, op, args }) + "\n");
    });
  }

  /** Close the browser, delete its profile and wait for the worker to exit. Idempotent. */
  async close(): Promise<void> {
    if (this.alive) {
      await this.request("close", {}, undefined, 30_000).catch(() => undefined);
      this.child.stdin.end();
    }
    const timer = setTimeout(() => this.child.kill(), 30_000);
    try { await this.exited; } finally { clearTimeout(timer); }
    if (this.child.exitCode !== 0) throw new WebError(`Browser cleanup is unconfirmed. ${this.stderr.trim()}`.trim());
  }
}
