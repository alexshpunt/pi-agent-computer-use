import { createHash, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

// Minimal RFC 6455 WebSocket for both ends, without dependencies: this file is copied alone to SSH hosts and runs
// under `node --experimental-strip-types`.

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const DEFAULT_MAX_MESSAGE = 65 * 1024 * 1024;
const MAX_HEAD = 16 * 1024;
const CLOSE_TIMEOUT_MS = 2000;

export const acceptKey = (key: string): string => createHash("sha1").update(key + GUID).digest("base64");

/** One frame. A client masks with a fresh random key; a server never masks. */
export function encodeFrame(opcode: number, payload: Buffer, mask: boolean, fin = true): Buffer {
  const length = payload.length;
  const extended = length < 126 ? 0 : length < 65536 ? 2 : 8;
  const head = Buffer.alloc(2 + extended + (mask ? 4 : 0));
  head[0] = (fin ? 0x80 : 0) | (opcode & 0x0f);
  head[1] = (mask ? 0x80 : 0) | (extended === 0 ? length : extended === 2 ? 126 : 127);
  if (extended === 2) head.writeUInt16BE(length, 2);
  else if (extended === 8) head.writeBigUInt64BE(BigInt(length), 2);
  if (!mask) return Buffer.concat([head, payload]);
  const key = randomBytes(4);
  key.copy(head, 2 + extended);
  const body = Buffer.from(payload);
  for (let i = 0; i < body.length; i++) body[i] ^= key[i & 3];
  return Buffer.concat([head, body]);
}

const utf8 = new TextDecoder("utf-8", { fatal: true });
const validCloseCode = (code: number) => code >= 1000 && code <= 1003 || code >= 1007 && code <= 1014 || code >= 3000 && code <= 4999;

/**
 * One WebSocket over a connected socket. Events: `message` (data: Buffer, binary: boolean), `pong` (data: Buffer) and
 * `close` (code, reason), the last fired exactly once when the socket is gone. Code 1006 means no close frame arrived.
 */
export class WsConnection extends EventEmitter {
  readonly socket: Duplex;
  private client: boolean;
  private maxMessage: number;
  private chunks: Buffer[] = [];
  private size = 0;
  private fragments: Buffer[] = [];
  private fragmentSize = 0;
  private fragmentOpcode = 0;
  private closeSent = false;
  private closeCode = 1006;
  private closeReason = "";
  private emittedClose = false;

  constructor(socket: Duplex, options: { client: boolean; head?: Buffer; maxMessage?: number }) {
    super();
    this.socket = socket;
    this.client = options.client;
    this.maxMessage = options.maxMessage ?? DEFAULT_MAX_MESSAGE;
    socket.on("error", () => {});
    socket.once("close", () => {
      if (this.emittedClose) return;
      this.emittedClose = true;
      this.emit("close", this.closeCode, this.closeReason);
    });
    socket.on("end", () => socket.end());
    // Bytes after the handshake head come first. Reading starts on the next turn, so listeners attached right after
    // construction (or after awaiting connectWebSocket) see the server's first messages.
    if (options.head?.length) { this.chunks.push(options.head); this.size = options.head.length; }
    socket.pause();
    setImmediate(() => {
      socket.on("data", (chunk: Buffer) => this.receive(chunk));
      this.receive(Buffer.alloc(0));
      socket.resume();
    });
  }

  get bufferedAmount(): number { return this.socket.writableLength; }
  get closing(): boolean { return this.closeSent || this.socket.destroyed; }

  /** A string goes as a text message, a Buffer as binary. False when closing or when the socket buffer is full. */
  send(data: string | Buffer): boolean {
    if (this.closing) return false;
    return this.socket.write(typeof data === "string" ? encodeFrame(1, Buffer.from(data, "utf8"), this.client) : encodeFrame(2, data, this.client));
  }
  ping(data = Buffer.alloc(0)): void { if (!this.closing) this.socket.write(encodeFrame(9, data, this.client)); }

  /** Start the closing handshake; the socket ends when the peer answers, or after a short timeout. */
  close(code = 1000, reason = ""): void {
    if (this.closeSent || this.socket.destroyed) return;
    this.closeSent = true;
    if (this.closeCode === 1006) { this.closeCode = code; this.closeReason = reason; }
    const reasonBytes = Buffer.from(reason, "utf8").subarray(0, 123);
    const payload = Buffer.alloc(2 + reasonBytes.length);
    payload.writeUInt16BE(code, 0);
    reasonBytes.copy(payload, 2);
    this.socket.write(encodeFrame(8, payload, this.client));
    setTimeout(() => this.socket.destroy(), CLOSE_TIMEOUT_MS).unref();
  }

  private fail(code: number, reason: string): void {
    this.chunks = []; this.size = 0;
    // After our close frame, garbage from the peer only ends the socket; the reported code stays.
    if (this.closeSent) { this.socket.destroy(); return; }
    this.closeCode = code; this.closeReason = reason;
    this.close(code, reason);
    this.socket.end();
  }

  private peek(n: number): Buffer | undefined {
    if (this.size < n) return undefined;
    if (this.chunks[0].length < n) this.chunks = [Buffer.concat(this.chunks)];
    return this.chunks[0];
  }
  private take(n: number): Buffer {
    const all = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks);
    const rest = all.subarray(n);
    this.chunks = rest.length ? [rest] : [];
    this.size -= n;
    return all.subarray(0, n);
  }

  private receive(chunk: Buffer): void {
    if (this.emittedClose) return;
    if (chunk.length) { this.chunks.push(chunk); this.size += chunk.length; }
    for (;;) {
      let head = this.peek(2);
      if (!head) return;
      const fin = (head[0] & 0x80) !== 0, opcode = head[0] & 0x0f, masked = (head[1] & 0x80) !== 0;
      let length = head[1] & 0x7f;
      const extended = length === 126 ? 2 : length === 127 ? 8 : 0;
      if (head[0] & 0x70) { this.fail(1002, "Reserved bits are set."); return; }
      if (masked === this.client) { this.fail(1002, this.client ? "A server frame is masked." : "A client frame is not masked."); return; }
      if (opcode >= 8 && (!fin || length > 125)) { this.fail(1002, "Invalid control frame."); return; }
      const headerLength = 2 + extended + (masked ? 4 : 0);
      head = this.peek(headerLength);
      if (!head) return;
      if (extended === 2) length = head.readUInt16BE(2);
      else if (extended === 8) {
        const big = head.readBigUInt64BE(2);
        if (big > BigInt(this.maxMessage)) { this.fail(1009, "Message too big."); return; }
        length = Number(big);
      }
      if (length > this.maxMessage || opcode < 8 && this.fragmentSize + length > this.maxMessage) { this.fail(1009, "Message too big."); return; }
      if (this.size < headerLength + length) return;
      const frame = this.take(headerLength + length);
      const payload = frame.subarray(headerLength);
      if (masked) { const key = frame.subarray(2 + extended, headerLength); for (let i = 0; i < payload.length; i++) payload[i] ^= key[i & 3]; }
      this.frame(fin, opcode, payload);
      if (this.socket.destroyed || this.emittedClose || this.size === 0) return;
    }
  }

  private frame(fin: boolean, opcode: number, payload: Buffer): void {
    if (opcode === 0 || opcode === 1 || opcode === 2) {
      if ((opcode === 0) !== (this.fragmentOpcode !== 0)) { this.fail(1002, opcode === 0 ? "Unexpected continuation frame." : "Expected a continuation frame."); return; }
      if (opcode !== 0) this.fragmentOpcode = opcode;
      this.fragments.push(payload);
      this.fragmentSize += payload.length;
      if (!fin) return;
      const data = this.fragments.length === 1 ? this.fragments[0] : Buffer.concat(this.fragments);
      const binary = this.fragmentOpcode === 2;
      this.fragments = []; this.fragmentSize = 0; this.fragmentOpcode = 0;
      if (!binary) { try { utf8.decode(data); } catch { this.fail(1007, "Text message is not UTF-8."); return; } }
      if (!this.closeSent) this.emit("message", data, binary);
    } else if (opcode === 8) {
      if (payload.length === 1) { this.fail(1002, "Invalid close frame."); return; }
      const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
      let reason = "";
      if (payload.length > 2) { try { reason = utf8.decode(payload.subarray(2)); } catch { this.fail(1007, "Close reason is not UTF-8."); return; } }
      if (code !== 1005 && !validCloseCode(code)) { this.fail(1002, "Invalid close code."); return; }
      this.closeCode = code; this.closeReason = reason;
      // The answer echoes the code and reason, so both ends report the same close.
      if (!this.closeSent) this.close(code === 1005 ? 1000 : code, reason);
      this.socket.end();
    } else if (opcode === 9) { if (!this.closing) this.socket.write(encodeFrame(10, payload, this.client)); }
    else if (opcode === 10) this.emit("pong", payload);
    else this.fail(1002, `Unknown opcode ${opcode}.`);
  }
}

/** A refused upgrade; `status` is the HTTP status, such as 401 or 410. */
export class WsUpgradeError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.name = "WsUpgradeError"; this.status = status; }
}

/** Client handshake on an already-connected socket. Bytes after the response head go to the connection. */
export function connectWebSocket(socket: Duplex, options: { host: string; path: string; protocols?: string[]; headers?: Record<string, string>; timeoutMs?: number }):
  Promise<{ ws: WsConnection; protocol?: string }> {
  return new Promise((resolve, reject) => {
    const key = randomBytes(16).toString("base64");
    let head = Buffer.alloc(0);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => { clearTimeout(timer); socket.off("data", data); socket.off("close", closed); socket.off("error", failed); };
    const fail = (error: Error) => { cleanup(); socket.destroy(); reject(error); };
    const failed = (error: Error) => fail(error);
    const closed = () => fail(new Error("The connection closed during the WebSocket upgrade."));
    const data = (chunk: Buffer) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end < 0) { if (head.length > MAX_HEAD) fail(new Error("The WebSocket upgrade response is too large.")); return; }
      const lines = head.subarray(0, end).toString("latin1").split("\r\n");
      const rest = head.subarray(end + 4);
      const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(lines[0])?.[1] ?? 0);
      const headers = new Map(lines.slice(1).map(line => {
        const colon = line.indexOf(":");
        return [line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim()] as const;
      }));
      if (status !== 101) { fail(new WsUpgradeError(status, `WebSocket upgrade to ${options.path.split("?")[0]} failed with HTTP ${status || "garbage"}.`)); return; }
      if (headers.get("upgrade")?.toLowerCase() !== "websocket" || headers.get("sec-websocket-accept") !== acceptKey(key)) {
        fail(new WsUpgradeError(status, "The WebSocket upgrade response is invalid.")); return;
      }
      const protocol = headers.get("sec-websocket-protocol");
      if (protocol !== undefined && !options.protocols?.includes(protocol)) { fail(new WsUpgradeError(status, `The server chose an unrequested subprotocol ${protocol}.`)); return; }
      cleanup();
      resolve({ ws: new WsConnection(socket, { client: true, head: rest }), ...(protocol ? { protocol } : {}) });
    };
    socket.on("data", data);
    socket.once("close", closed);
    socket.once("error", failed);
    if (options.timeoutMs) timer = setTimeout(() => fail(new Error("The WebSocket upgrade timed out.")), options.timeoutMs);
    const extra = Object.entries(options.headers ?? {}).map(([name, value]) => `${name}: ${value}\r\n`).join("");
    socket.write(`GET ${options.path} HTTP/1.1\r\nHost: ${options.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n`
      + `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n`
      + (options.protocols?.length ? `Sec-WebSocket-Protocol: ${options.protocols.join(", ")}\r\n` : "") + `${extra}\r\n`);
    socket.resume();
  });
}

/** Server handshake for an http server's `upgrade` event; answers 400 and destroys the socket on a bad request. */
export function acceptWebSocket(req: IncomingMessage, socket: Duplex, head: Buffer, protocol?: string): WsConnection | undefined {
  const key = req.headers["sec-websocket-key"];
  const tokens = (value: string | string[] | undefined) => String(value ?? "").toLowerCase().split(",").map(token => token.trim());
  if (req.method !== "GET" || !tokens(req.headers.upgrade).includes("websocket") || !tokens(req.headers.connection).includes("upgrade")
    || req.headers["sec-websocket-version"] !== "13" || typeof key !== "string" || Buffer.from(key, "base64").length !== 16) {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    socket.destroy();
    return undefined;
  }
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(key)}\r\n`
    + (protocol ? `Sec-WebSocket-Protocol: ${protocol}\r\n` : "") + "\r\n");
  return new WsConnection(socket, { client: false, head });
}
