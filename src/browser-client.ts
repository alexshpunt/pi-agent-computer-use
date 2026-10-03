import { spawn, execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { BrowserResult } from "./browser-session.ts";
import { cleanupBrowserProfile } from "./browser-profile.ts";

const run = promisify(execFile);
/** The only protocol operations accepted by the trusted Windows browser worker. */
export type BrowserOperation = "open" | "observe" | "act" | "tabs" | "close";
interface Request {
  resolve(result: BrowserResult): void;
  reject(error: Error): void;
}

/** Owned Windows Node stdio bridge. No personal-browser attachment or listening socket. */
export class BrowserClient {
  private child?: ChildProcessWithoutNullStreams;
  private pending = new Map<number, Request>();
  private serial = 0;
  private tail: Promise<unknown> = Promise.resolve();
  private buffer = "";
  private stderr = "";
  private ownedProfile?: string;
  private exited?: Promise<void>;
  private retiring?: Promise<void>;
  private readonly launcher?: () => Promise<ChildProcessWithoutNullStreams>;

  /** An injected launcher must return a new owned stdio worker; used by protocol contract tests. */
  constructor(launcher?: () => Promise<ChildProcessWithoutNullStreams>) { this.launcher = launcher; }

  private async launch(): Promise<ChildProcessWithoutNullStreams> {
    if (this.launcher) return this.launcher();
    let command: string;
    let worker = fileURLToPath(new URL("./browser-worker.ts", import.meta.url));
    if (process.platform === "win32") command = process.execPath;
    else if (process.platform === "linux" && process.env.WSL_DISTRO_NAME) {
      command = "/mnt/c/Program Files/nodejs/node.exe";
      await access(command);
      worker = (await run("wslpath", ["-w", worker], { timeout: 5000 })).stdout.trim();
    } else throw new Error("Visible browser currently requires Windows, or WSL with Windows Node installed.");
    return spawn(command, [worker], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  }

  private async start(): Promise<void> {
    if (this.retiring) await this.retiring;
    if (this.child) return;
    await this.retire();
    this.buffer = ""; this.stderr = "";
    const child = await this.launch();
    this.child = child;
    this.exited = new Promise<void>(resolve => child.once("close", () => {
      if (this.child === child) this.child = undefined;
      this.fail(new Error("Browser worker disconnected. " + this.stderr));
      resolve();
      this.retireInBackground();
    }));
    child.on("error", error => { this.fail(error); this.retireInBackground(); });
    child.stdin.on("error", error => { this.fail(error); this.retireInBackground(); });
    child.stderr.on("data", chunk => { this.stderr = (this.stderr + chunk.toString()).slice(-2000); });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      this.buffer += chunk.toString();
      if (this.buffer.length > 24_000_000) { this.fail(new Error("Browser response exceeds limit.")); this.retireInBackground(); return; }
      let end: number;
      while ((end = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
        try {
          const response = JSON.parse(line);
          if (response.event === "profile-created" && typeof response.profile === "string") {
            if (this.ownedProfile && this.ownedProfile !== response.profile) throw new Error("Unexpected second profile lease.");
            this.ownedProfile = response.profile;
            continue;
          }
          const request = this.pending.get(response.id);
          if (!request || !response.result?.details?.status || !Array.isArray(response.result.content)) throw new Error("Invalid browser response.");
          this.pending.delete(response.id);
          request.resolve(response.result);
        } catch { this.fail(new Error("Invalid browser response; connection discarded.")); this.retireInBackground(); }
      }
    });
  }

  private fail(error: Error): void {
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }

  private retireInBackground(): void {
    // Keep a failed lease for explicit close/start to retry and report, without an unhandled rejection.
    void this.retire().catch(() => undefined);
  }

  private retire(): Promise<void> {
    if (this.retiring) return this.retiring;
    const child = this.child;
    const exited = this.exited;
    if (!child && !this.ownedProfile) return Promise.resolve();
    this.retiring = (async () => {
      child?.stdin.end();
      const timer = child ? setTimeout(() => { child.kill(); }, 35_000) : undefined;
      try {
        if (child) await exited;
        if (this.ownedProfile) {
          await cleanupBrowserProfile(this.ownedProfile);
          this.ownedProfile = undefined;
        }
      } finally {
        if (timer) clearTimeout(timer);
        this.retiring = undefined;
      }
    })();
    return this.retiring;
  }

  /** Send one bounded operation. Cancellation ends the owned pipe, which triggers Windows-side owned browser cleanup. */
  private async request(operation: BrowserOperation, args: Record<string, unknown> = {}, signal?: AbortSignal): Promise<BrowserResult> {
    const work = async (): Promise<BrowserResult> => {
      if (signal?.aborted) return this.error(false, "Cancelled before browser dispatch.");
      let sent = false;
      let abort: (() => void) | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const start = performance.now();
      try {
        await this.start();
        if (signal?.aborted) return this.error(false, "Cancelled before browser dispatch.");
        const id = ++this.serial;
        const result = await new Promise<BrowserResult>((resolve, reject) => {
          this.pending.set(id, { resolve, reject });
          abort = () => {
            this.fail(new Error("Browser operation cancelled; observe before any retry."));
            this.retireInBackground();
          };
          signal?.addEventListener("abort", abort, { once: true });
          timer = setTimeout(() => {
            this.fail(new Error("Browser operation timed out; outcome may be partial."));
            this.retireInBackground();
          }, 40_000);
          sent = true;
          this.child!.stdin.write(JSON.stringify({ id, operation, args }) + "\n");
        });
        result.details.elapsed_ms = Math.round(performance.now() - start);
        return result;
      } catch (error) {
        return this.error(sent && ["open", "act"].includes(operation), error instanceof Error ? error.message : String(error));
      } finally {
        if (abort) signal?.removeEventListener("abort", abort);
        if (timer) clearTimeout(timer);
      }
    };
    return work();
  }

  private queue(work: () => Promise<BrowserResult>): Promise<BrowserResult> {
    const result = this.tail.then(work, work);
    this.tail = result.catch(() => undefined);
    return result;
  }

  /** Serialize requests, including startup and close, on this one owned pipe. */
  call(operation: BrowserOperation, args: Record<string, unknown> = {}, signal?: AbortSignal): Promise<BrowserResult> {
    if (operation === "close") return this.close();
    return this.queue(() => this.request(operation, args, signal));
  }

  private error(unknown: boolean, reason: string): BrowserResult {
    return { content: [{ type: "text", text: (unknown
      ? "Outcome unknown. Never replay blindly; discover fresh owned tabs before deciding. "
      : "Browser refused before input. ") + reason }],
      details: { status: unknown ? "unknown" : "refused" }, isError: true };
  }

  /** Close only the owned browser/context, then end and await the worker pipe. Idempotent. */
  close(): Promise<BrowserResult> {
    return this.queue(async () => {
      try {
        if (this.retiring) await this.retiring;
        if (!this.child) {
          await this.retire();
          return { content: [{ type: "text", text: "No owned browser runtime is running." }], details: { status: "closed" } };
        }
        const result = await this.request("close");
        await this.retire();
        return result;
      } catch (error) {
        return this.error(true, "Owned browser cleanup needs attention: " + (error instanceof Error ? error.message : String(error)));
      }
    });
  }
}
