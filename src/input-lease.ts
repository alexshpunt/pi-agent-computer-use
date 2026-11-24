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

/**
 * One agent's rectangle of a shared screen, in physical screen pixels: the whole work area for one agent, the left or
 * right half for two, a quarter for three or four. It changes as agents join and leave.
 */
export interface ScreenZone {
  x: number; y: number; width: number; height: number;
  /** This agent's place among the agents on the screen, in the order they joined, from 0. */
  index: number;
  /** How many agents share the screen. */
  count: number;
  /** The work area the zones split. */
  screen: { width: number; height: number };
}
/** The most agents with a screen zone in one shared sandbox; the guest's PiZones.MaxSeats. */
export const MAX_ZONES = 4;

/** Where a zone lies on the screen, in words. */
export function zoneName(zone: ScreenZone): string {
  if (zone.count <= 1) return "all";
  if (zone.count === 2) return zone.index === 0 ? "the left half" : "the right half";
  return ["the top-left quarter", "the top-right quarter", "the bottom-left quarter", "the bottom-right quarter"][zone.index] ?? "a quarter";
}

/** One line that tells the agent its zone. */
export function zoneText(zone: ScreenZone): string {
  const others = zone.count - 1;
  return `Screen zone: ${zoneName(zone)} of the sandbox screen, ${zone.width}x${zone.height} at ${zone.x},${zone.y} of ${zone.screen.width}x${zone.screen.height}`
    + ` (${others ? `shared with ${others} other ${others === 1 ? "agent" : "agents"}` : "no other agent here now"}).`;
}

/** Parse the guest's zone line: `zone <x> <y> <width> <height> <index> <count> <screen width> <screen height>`. */
export function parseZone(line: string): ScreenZone | undefined {
  const match = /^zone (-?\d+) (-?\d+) (\d+) (\d+) (\d+) (\d+) (\d+) (\d+)$/.exec(line);
  if (!match) return undefined;
  const [x, y, width, height, index, count, screenWidth, screenHeight] = match.slice(1).map(Number);
  if (width <= 0 || height <= 0 || count < 1 || index >= count) return undefined;
  return { x, y, width, height, index, count, screen: { width: screenWidth, height: screenHeight } };
}

/** Turns with one desktop's input, shared by the agent sessions on it. */
export interface InputLease {
  /** Wait for this session's turn. Cancelling leaves the queue; nothing is held afterwards. */
  acquire(signal?: AbortSignal): Promise<LeaseGrant>;
  /** Claim a process for this session; false when another session on the desktop already claimed it. Claims end with the session. */
  claim(pid: number, signal?: AbortSignal): Promise<boolean>;
  /**
   * Take a zone of the shared screen; "full" when MAX_ZONES agents already have one, "off" when the sandbox was started
   * without zones. A lost connection joins again.
   */
  join?(signal?: AbortSignal): Promise<ScreenZone | "full" | "off">;
  /** This session's current zone; undefined when it has none, such as after a reconnect found every zone taken. */
  zone?(signal?: AbortSignal): Promise<ScreenZone | undefined>;
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
  /** This session joined the screen zones; a new connection joins again. */
  private joined = false;

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

  join(signal?: AbortSignal): Promise<ScreenZone | "full" | "off"> {
    return this.serial(async () => {
      const reply = await this.request(await this.open(signal), "join");
      if (/^full \d+$/.test(reply)) return "full";
      if (reply === "off") return "off";
      const zone = parseZone(reply);
      if (!zone) throw new Error(`Unexpected lease reply: ${reply.slice(0, 80)}`);
      this.joined = true;
      return zone;
    });
  }

  zone(signal?: AbortSignal): Promise<ScreenZone | undefined> {
    return this.serial(async () => {
      const reply = await this.request(await this.open(signal), "zone");
      if (reply === "none") return undefined;
      const zone = parseZone(reply);
      if (!zone) throw new Error(`Unexpected lease reply: ${reply.slice(0, 80)}`);
      return zone;
    });
  }

  /**
   * Leave for good: the guest frees this session's zone at once and lays out the others. A connection that only
   * closes, such as a cancelled wait for the input, keeps the zone for a reconnect.
   */
  close(): void {
    this.closed = true;
    const socket = this.socket;
    this.socket = undefined;
    // The socket's close event no longer reaches fail(), so requests in flight end here.
    for (const reply of this.replies.splice(0)) reply.reject(new Error("The input lease is closed."));
    if (!socket || socket.destroyed) return;
    socket.end("leave\n");
    setTimeout(() => socket.destroy(), 2000).unref();
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
      // Closed while connecting: a connection that went on would hold this session's zone until Pi exits.
      if (this.closed) { socket.destroy(); throw new Error("The input lease is closed."); }
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
      // A seat the guest still keeps under this session's name comes back as it was; otherwise this joins anew.
      if (this.joined) await this.request(socket, "join");
      return socket;
    })().finally(() => { this.connecting = undefined; });
    return this.connecting;
  }

  private request(socket: Socket, line: string): Promise<string> {
    return new Promise((resolve, reject) => {
      // An ended socket is one close() sent leave on, possibly in the middle of opening it.
      if (socket.destroyed || socket.writableEnded) { reject(new Error("The shared input lease connection closed.")); return; }
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
    if (this.joined && !this.closed) this.rejoin(0);
  }

  /**
   * Connect again right away after a lost connection, such as a cancelled wait for the input: the guest keeps this
   * session's zone only for a few seconds, and the agent's next request may come much later.
   */
  private rejoin(attempt: number): void {
    setTimeout(() => {
      if (this.closed || (this.socket && !this.socket.destroyed)) return;
      this.serial(() => this.open()).catch(() => { if (attempt < 8) this.rejoin(attempt + 1); });
    }, attempt ? 1000 : 50).unref();
  }
}
