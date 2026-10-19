import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { connect } from "node:net";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { WindowTarget } from "./session.ts";

/** A line-oriented connection to one window identity peer. Ending input makes the peer remove its markers and exit. */
export interface IdentityChannel {
  input: Writable;
  output: Readable;
  /** Called once when the peer is gone. */
  onExit(listener: () => void): void;
  /** Stop forcibly after a graceful end did not finish. */
  kill(): void;
  /** Recent diagnostic output, if any. */
  diagnostics(): string;
}
export type IdentityConnector = () => Promise<IdentityChannel>;

/** Start the identity peer as a host PowerShell child, through WSL interop when needed. */
export function hostIdentityPeer(interop?: string): IdentityConnector {
  return async () => {
    const script = await readFile(new URL("../scripts/window-identity.ps1", import.meta.url), "utf8");
    const child = spawn(process.platform === "win32" ? "powershell.exe" : "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe", [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64"),
    ], { stdio: "pipe", env: { ...process.env, ...(interop ? { WSL_INTEROP: interop } : {}) } });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-2000); });
    return {
      input: child.stdin, output: child.stdout,
      onExit: listener => { child.on("error", listener); child.on("exit", listener); },
      kill: () => child.kill(),
      diagnostics: () => stderr,
    };
  };
}

/** Reach an identity peer that a sandbox guest starts for each TCP connection. */
export function remoteIdentityPeer(port: number, host = "127.0.0.1"): IdentityConnector {
  return () => new Promise((resolve, reject) => {
    const socket = connect({ host, port }, () => {
      socket.off("error", reject);
      resolve({ input: socket, output: socket, onExit: listener => socket.on("close", listener), kill: () => socket.destroy(), diagnostics: () => "" });
    });
    socket.once("error", reject);
  });
}

/** One owned identity peer binds references to window lifetimes, not just reusable HWNDs. */
export class WindowIdentity {
  private channel?: IdentityChannel;
  private exited?: Promise<void>;
  private pending?: { resolve(value: string | undefined): void; reject(error: Error): void };

  constructor(private readonly connect: IdentityConnector) {}

  private async start(): Promise<void> {
    if (this.channel) return;
    const channel = await this.connect();
    this.channel = channel;
    const fail = (error: Error) => { this.pending?.reject(error); this.pending = undefined; };
    this.exited = new Promise(resolve => channel.onExit(() => {
      if (this.channel === channel) this.channel = undefined;
      fail(new Error(`Window identity peer exited. ${channel.diagnostics()}`));
      resolve();
    }));
    createInterface({ input: channel.output }).on("line", (line) => {
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
        this.channel!.input.write(JSON.stringify({ ...target, create }) + "\n", error => {
          if (error) finish(error);
        });
      });
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  /** End input so the peer removes its surviving markers and exits; never kills applications. */
  async close(): Promise<void> {
    const channel = this.channel;
    const exited = this.exited;
    this.channel = undefined;
    if (!channel) return;
    this.pending?.reject(new Error("Window identity peer closed."));
    this.pending = undefined;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { channel.kill(); resolve(); }, 5000);
      void exited?.then(() => { clearTimeout(timer); resolve(); });
      channel.input.end();
    });
  }
}
