import type { Socket } from "node:net";

/** This session's turn with a shared desktop's mouse and keyboard. */
export interface LeaseGrant {
  /** How long the turn took to come. */
  waitedMs: number;
  /** Another agent's unfinished menu, capture or pressed button was cancelled to give this turn. */
  revoked: boolean;
  /** End the turn. The guest keeps it for this session while its menu or drag is still open; that reason is returned. */
  release(): Promise<string | undefined>;
}

/** Turns with one desktop's input, shared by the agent sessions on it. */
export interface InputLease {
  /** Wait for this session's turn. Cancelling leaves the queue; nothing is held afterwards. */
  acquire(signal?: AbortSignal): Promise<LeaseGrant>;
  /** Claim a process for this session; false when another session on the desktop already claimed it. Claims end with the session. */
  claim(pid: number, signal?: AbortSignal): Promise<boolean>;
  close(): void;
}

const LINE_LIMIT = 256;
/** How long an unfinished menu or pressed button keeps a session's turn while another waits; StickyMs of scripts/sandbox/guest-lease.ps1. */
export const STICKY_SECONDS = 15;

/**
 * Client of the shared sandbox's guest lease service (scripts/sandbox/guest-lease.cs) over one long-lived connection.
 * A lost connection gives up the turn on the guest side; the next acquire connects again.
 */
export class GuestInputLease implements InputLease {
  private socket?: Socket;
  private connecting?: Promise<Socket>;
  private buffer = "";
  private readonly replies: { resolve(line: string): void; reject(error: Error): void }[] = [];
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;
  /** Processes this session claimed; a new connection claims them again, since the guest forgets a closed one's claims. */
  private readonly claimed = new Set<number>();

  constructor(private readonly options: { connect(signal?: AbortSignal): Promise<Socket>; token: string; agent: string }) {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(options.agent)) throw new Error("Invalid lease agent name.");
  }

  acquire(signal?: AbortSignal): Promise<LeaseGrant> {
    return this.serial(async () => {
      signal?.throwIfAborted();
      const socket = await this.open(signal);
      // An abort listener added after the abort never runs: check first, or the wait would last until the turn comes.
      signal?.throwIfAborted();
      const abort = () => socket.destroy(new Error("Cancelled while waiting for the shared input."));
      signal?.addEventListener("abort", abort, { once: true });
      let reply: string;
      try { reply = await this.request(socket, "acquire"); }
      finally { signal?.removeEventListener("abort", abort); }
      const match = /^granted (\d+) ([01])$/.exec(reply);
      if (!match) { socket.destroy(); throw new Error(`Unexpected lease reply: ${reply.slice(0, 80)}`); }
      let released = false;
      return { waitedMs: Number(match[1]), revoked: match[2] === "1",
        release: () => released ? Promise.resolve(undefined) : this.serial(async () => {
          released = true;
          // A connection that is gone already gave the turn up on the guest.
          if (socket !== this.socket || socket.destroyed) return undefined;
          const answer = await this.request(socket, "release").catch(() => "released");
          return answer.startsWith("held ") ? answer.slice(5) : undefined;
        }) };
    });
  }

  claim(pid: number, signal?: AbortSignal): Promise<boolean> {
    if (!Number.isSafeInteger(pid) || pid <= 0) return Promise.resolve(false);
    return this.serial(async () => {
      const reply = await this.request(await this.open(signal), `claim ${pid}`);
      if (reply !== "claimed" && reply !== "taken") throw new Error(`Unexpected lease reply: ${reply.slice(0, 80)}`);
      if (reply === "claimed") this.claimed.add(pid);
      return reply === "claimed";
    });
  }

  close(): void {
    this.closed = true;
    this.socket?.destroy();
    this.socket = undefined;
  }

  /** One request at a time: replies arrive in order on the one connection. */
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work, work);
    this.tail = result.catch(() => undefined);
    return result;
  }

  private async open(signal?: AbortSignal): Promise<Socket> {
    if (this.closed) throw new Error("The input lease is closed.");
    if (this.socket && !this.socket.destroyed) return this.socket;
    this.connecting ??= (async () => {
      const socket = await this.options.connect(signal);
      socket.setNoDelay(true);
      socket.setEncoding("utf8");
      this.buffer = "";
      socket.on("data", (chunk: string) => this.receive(socket, chunk));
      socket.on("close", () => this.fail(socket, new Error("The shared input lease connection closed.")));
      socket.on("error", () => undefined);
      this.socket = socket;
      const hello = await this.request(socket, `auth ${this.options.token} ${this.options.agent}`);
      if (hello !== "ok") { socket.destroy(); throw new Error("The shared input lease refused this session."); }
      for (const pid of this.claimed) if (await this.request(socket, `claim ${pid}`) !== "claimed") this.claimed.delete(pid);
      return socket;
    })().finally(() => { this.connecting = undefined; });
    return this.connecting;
  }

  private request(socket: Socket, line: string): Promise<string> {
    return new Promise((resolve, reject) => {
      if (socket.destroyed) { reject(new Error("The shared input lease connection closed.")); return; }
      this.replies.push({ resolve, reject });
      socket.write(`${line}\n`);
    });
  }

  private receive(socket: Socket, chunk: string): void {
    if (socket !== this.socket) return;
    this.buffer += chunk;
    let end: number;
    while ((end = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, end).replace(/\r$/, "");
      this.buffer = this.buffer.slice(end + 1);
      this.replies.shift()?.resolve(line);
    }
    if (this.buffer.length > LINE_LIMIT) socket.destroy();
  }

  private fail(socket: Socket, error: Error): void {
    if (socket !== this.socket) return;
    this.socket = undefined;
    for (const reply of this.replies.splice(0)) reply.reject(error);
  }
}
