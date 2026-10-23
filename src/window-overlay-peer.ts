import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { OverlayCommand, OverlayPeer, OverlayReply } from "./window-overlay.ts";

/** Spawn only a trusted helper binary. It speaks bounded JSON-line requests and exits on stdin EOF. */
export async function startOverlayPeer(command: string, args: string[] = [], interop?: string): Promise<NativeOverlayPeer> {
  const peer = new NativeOverlayPeer(spawn(command, args, { stdio: "pipe", windowsHide: true,
    env: { ...process.env, ...(interop ? { WSL_INTEROP: interop } : {}) } }));
  try { await peer.started; return peer; }
  catch (error) { await peer.close().catch(() => undefined); throw error; }
}

/** Own the rendering child's protocol and cleanup, never a source application or a shared Windows process. */
export class NativeOverlayPeer implements OverlayPeer {
  readonly started: Promise<void>;
  ready?: Record<string, unknown>;
  private pending = new Map<number, { finish(error?: Error, reply?: OverlayReply): void }>();
  private closed = false;
  private failure?: Error;
  private closePromise?: Promise<void>;

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    this.started = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => fail(new Error("Qt frame startup timed out.")), 10_000);
      const fail = (error: Error) => {
        clearTimeout(timer); this.failure = error; reject(error);
        for (const item of [...this.pending.values()]) item.finish(error);
        this.child.stdin.end();
      };
      child.once("error", fail);
      child.once("exit", () => fail(new Error("Qt frame process exited.")));
      child.stderr.resume();
      createInterface({ input: child.stdout }).on("line", line => {
        try {
          if (line.length > 16384) throw new Error("Oversized Qt frame reply.");
          const reply = JSON.parse(line) as Record<string, unknown>;
          if (!reply || typeof reply !== "object" || typeof reply.status !== "string" || !Number.isSafeInteger(reply.generation))
            throw new Error("Invalid Qt frame reply.");
          if (reply.generation === 0 && !this.ready) {
            if (reply.status !== "ready" || reply.protocol_version !== 2 || reply.capture_affinity !== 0x11 || !Number.isSafeInteger(reply.pid) || !Number.isSafeInteger(reply.overlay_hwnd))
              throw new Error("Qt frame capture exclusion is unavailable.");
            this.ready = reply; clearTimeout(timer); resolve();
          } else this.pending.get(reply.generation as number)?.finish(undefined, reply as unknown as OverlayReply);
        } catch { fail(new Error("Qt frame protocol failed.")); }
      });
    });
  }

  /** Wait for the exact generation acknowledgement; never repeat a timed-out request. */
  async send(command: OverlayCommand): Promise<OverlayReply> {
    await this.started;
    if (this.closed || this.failure || this.child.exitCode !== null) throw new Error("Qt frame peer is unavailable.");
    if (this.pending.has(command.generation)) throw new Error("Duplicate Qt frame generation.");
    return new Promise((resolve, reject) => {
      const finish = (error?: Error, reply?: OverlayReply) => {
        clearTimeout(timer); this.pending.delete(command.generation);
        if (error) reject(error); else resolve(reply!);
      };
      const timer = setTimeout(() => {
        this.failure = new Error("Qt frame acknowledgement timed out."); this.child.stdin.end(); finish(this.failure);
      }, 2000);
      this.pending.set(command.generation, { finish });
      this.child.stdin.write(JSON.stringify(command) + "\n", error => { if (error) finish(error); });
    });
  }

  /** EOF first; report uncertain shutdown instead of claiming the native process is gone. */
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    for (const item of [...this.pending.values()]) item.finish(new Error("Qt frame peer closed."));
    return this.closePromise = new Promise<void>((resolve, reject) => {
      if (this.child.pid === undefined || this.child.exitCode !== null || this.child.signalCode !== null) { resolve(); return; }
      const timer = setTimeout(() => { this.child.kill(); reject(new Error("Qt frame shutdown is unconfirmed.")); }, 5000);
      this.child.once("exit", () => { clearTimeout(timer); resolve(); });
      this.child.stdin.end();
    });
  }
}
