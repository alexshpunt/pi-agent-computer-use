import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import type { WindowTarget } from "./session.ts";

/** One owned PowerShell peer binds references to window lifetimes, not just reusable HWNDs. */
export class WindowIdentity {
  private child?: ChildProcessWithoutNullStreams;
  private pending?: { resolve(value: string | undefined): void; reject(error: Error): void };
  private stderr = "";

  constructor(private readonly interop?: string) {}

  private async start(): Promise<void> {
    if (this.child) return;
    const script = await readFile(new URL("../scripts/window-identity.ps1", import.meta.url), "utf8");
    const child = spawn(process.platform === "win32" ? "powershell.exe" : "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe", [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64"),
    ], { stdio: "pipe", env: { ...process.env, ...(this.interop ? { WSL_INTEROP: this.interop } : {}) } });
    this.child = child;
    this.stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { this.stderr = (this.stderr + chunk.toString()).slice(-2000); });
    const fail = (error: Error) => { this.pending?.reject(error); this.pending = undefined; };
    child.on("error", fail);
    child.on("exit", () => {
      if (this.child === child) this.child = undefined;
      fail(new Error(`Window identity peer exited. ${this.stderr}`));
    });
    createInterface({ input: child.stdout }).on("line", (line) => {
      const pending = this.pending;
      this.pending = undefined;
      if (!pending) return;
      try {
        const state = JSON.parse(line) as { identity?: string | null; error?: string };
        if (state.error) pending.reject(new Error(state.error));
        else pending.resolve(state.identity ?? undefined);
      } catch { pending.reject(new Error("Invalid window identity response.")); }
    });
  }

  /** Create a private lifetime marker on discovery, or check one without recreating it. Calls must be serialized. */
  async identify(target: WindowTarget, create: boolean, signal?: AbortSignal): Promise<string | undefined> {
    if (signal?.aborted) throw new Error("Cancelled before window identity check.");
    await this.start();
    if (signal?.aborted) throw new Error("Cancelled before window identity check.");
    if (this.pending) throw new Error("Concurrent window identity requests are not supported.");
    try {
      return await new Promise<string | undefined>((resolve, reject) => {
        const finish = (error?: Error, value?: string) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          this.pending = undefined;
          if (error) reject(error); else resolve(value);
        };
        const abort = () => finish(new Error("Cancelled during window identity check."));
        const timer = setTimeout(() => finish(new Error("Window identity check timed out.")), 15_000);
        this.pending = { resolve: value => finish(undefined, value), reject: error => finish(error) };
        signal?.addEventListener("abort", abort, { once: true });
        this.child!.stdin.write(JSON.stringify({ ...target, create }) + "\n", error => {
          if (error) finish(error);
        });
      });
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  /** EOF removes this peer's surviving markers and exits; never kills applications. */
  async close(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    if (!child || child.exitCode !== null) return;
    this.pending?.reject(new Error("Window identity peer closed."));
    this.pending = undefined;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { child.kill(); resolve(); }, 5000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
      child.stdin.end();
    });
  }
}
