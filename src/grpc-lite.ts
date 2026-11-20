import http2 from "node:http2";
import type { Duplex } from "node:stream";

// Minimal protobuf wire format and a gRPC client over one already-connected h2c socket, without dependencies:
// this file is copied alone to SSH hosts and runs under `node --experimental-strip-types`.

function varint(value: number | bigint): Buffer {
  let v = BigInt(value);
  if (v < 0n) throw new Error("Negative varints are not supported.");
  const out: number[] = [];
  while (v >= 0x80n) { out.push(Number(v & 0x7fn) | 0x80); v >>= 7n; }
  out.push(Number(v));
  return Buffer.from(out);
}
const tag = (field: number, wire: number) => varint((field << 3) | wire);

/** Builds one protobuf message. Zero, empty and false values are skipped as proto3 does. */
export class ProtoWriter {
  private parts: Buffer[] = [];
  string(field: number, value: string | undefined): this {
    if (value) { const bytes = Buffer.from(value, "utf8"); this.parts.push(tag(field, 2), varint(bytes.length), bytes); }
    return this;
  }
  bytes(field: number, value: Buffer | undefined): this {
    if (value?.length) this.parts.push(tag(field, 2), varint(value.length), value);
    return this;
  }
  uint(field: number, value: number | bigint | undefined): this {
    if (value !== undefined && BigInt(value) !== 0n) this.parts.push(tag(field, 0), varint(value));
    return this;
  }
  bool(field: number, value: boolean | undefined): this { return value ? this.uint(field, 1) : this; }
  double(field: number, value: number | undefined): this {
    if (value) { const bytes = Buffer.alloc(8); bytes.writeDoubleLE(value); this.parts.push(tag(field, 1), bytes); }
    return this;
  }
  /** A nested message is written even when empty: its presence can matter (oneof arms, set sub-messages). */
  message(field: number, value: Buffer | ProtoWriter): this {
    const bytes = value instanceof ProtoWriter ? value.finish() : value;
    this.parts.push(tag(field, 2), varint(bytes.length), bytes);
    return this;
  }
  packed(field: number, values: readonly (number | bigint)[]): this {
    if (values.length) { const bytes = Buffer.concat(values.map(varint)); this.parts.push(tag(field, 2), varint(bytes.length), bytes); }
    return this;
  }
  finish(): Buffer { return Buffer.concat(this.parts); }
}

type Field = { wire: 0; value: bigint } | { wire: 1 | 2 | 5; value: Buffer };

function readVarint(buf: Buffer, offset: number): [bigint, number] {
  let result = 0n, shift = 0n;
  for (let i = offset; i < buf.length && i < offset + 10; i++) {
    const byte = buf[i];
    result |= BigInt(byte & 0x7f) << shift;
    if (!(byte & 0x80)) return [result, i + 1];
    shift += 7n;
  }
  throw new Error("Malformed protobuf varint.");
}

/** Read-only view of one decoded message; repeated scalar fields keep the last value, as protobuf does. */
export class ProtoMessage {
  private fields = new Map<number, Field[]>();
  constructor(buf: Buffer) {
    let offset = 0;
    while (offset < buf.length) {
      const [key, next] = readVarint(buf, offset);
      offset = next;
      const field = Number(key >> 3n), wire = Number(key & 7n);
      if (field < 1) throw new Error("Malformed protobuf field number.");
      let entry: Field;
      if (wire === 0) { const [value, end] = readVarint(buf, offset); entry = { wire, value }; offset = end; }
      else if (wire === 1 || wire === 5) {
        const size = wire === 1 ? 8 : 4;
        if (offset + size > buf.length) throw new Error("Truncated protobuf field.");
        entry = { wire, value: buf.subarray(offset, offset + size) }; offset += size;
      } else if (wire === 2) {
        const [length, start] = readVarint(buf, offset);
        if (BigInt(start) + length > BigInt(buf.length)) throw new Error("Truncated protobuf field.");
        offset = start + Number(length);
        entry = { wire, value: buf.subarray(start, offset) };
      } else throw new Error(`Unsupported protobuf wire type ${wire}.`);
      const list = this.fields.get(field);
      if (list) list.push(entry); else this.fields.set(field, [entry]);
    }
  }
  private last(field: number, wire: number): Field | undefined {
    const list = this.fields.get(field);
    for (let i = (list?.length ?? 0) - 1; i >= 0; i--) if (list![i].wire === wire) return list![i];
    return undefined;
  }
  has(field: number): boolean { return this.fields.has(field); }
  big(field: number): bigint { return (this.last(field, 0)?.value as bigint | undefined) ?? 0n; }
  /** Exact up to 2^53; larger values lose precision (use big()). */
  uint(field: number): number { return Number(this.big(field)); }
  bool(field: number): boolean { return this.big(field) !== 0n; }
  double(field: number): number { return (this.last(field, 1)?.value as Buffer | undefined)?.readDoubleLE(0) ?? 0; }
  bytes(field: number): Buffer | undefined { return this.last(field, 2)?.value as Buffer | undefined; }
  str(field: number): string { return this.bytes(field)?.toString("utf8") ?? ""; }
  msg(field: number): ProtoMessage | undefined { const bytes = this.bytes(field); return bytes ? new ProtoMessage(bytes) : undefined; }
  msgs(field: number): ProtoMessage[] { return (this.fields.get(field) ?? []).filter(f => f.wire === 2).map(f => new ProtoMessage(f.value as Buffer)); }
  /** Repeated varints, packed or not. */
  uints(field: number): number[] {
    const out: number[] = [];
    for (const f of this.fields.get(field) ?? []) {
      if (f.wire === 0) out.push(Number(f.value));
      else if (f.wire === 2) for (let offset = 0; offset < f.value.length;) { const [value, next] = readVarint(f.value, offset); out.push(Number(value)); offset = next; }
    }
    return out;
  }
}

export const decodeProto = (buf: Buffer): ProtoMessage => new ProtoMessage(buf);

/** A non-OK gRPC status. `code` is the numeric gRPC status code. */
export class GrpcError extends Error {
  readonly code: number;
  constructor(code: number, message: string) { super(message); this.name = "GrpcError"; this.code = code; }
}

/** gRPC's HTTP-to-status mapping for responses that are not gRPC at all. */
const HTTP_STATUS: Record<number, number> = { 400: 13, 401: 16, 403: 7, 404: 12, 429: 14, 502: 14, 503: 14, 504: 14 };
const MAX_MESSAGE = 64 * 1024 * 1024;

function decodeMessage(value: unknown): string {
  const text = Array.isArray(value) ? value.join(",") : String(value ?? "");
  try { return decodeURIComponent(text); } catch { return text; }
}

export interface GrpcCallOptions { signal?: AbortSignal; timeoutMs?: number }

/**
 * gRPC client over one connected socket (prior-knowledge h2c). The caller authenticates the socket first, then hands
 * it over. `closed` settles when the HTTP/2 session ends, so callers can reconnect.
 */
export class GrpcClient {
  readonly closed: Promise<void>;
  private session: http2.ClientHttp2Session;
  private token?: string;
  constructor(socket: Duplex, options: { token?: string } = {}) {
    this.token = options.token;
    this.session = http2.connect("http://localhost", { createConnection: () => socket });
    this.session.on("error", () => {});
    this.closed = new Promise(resolve => this.session.once("close", () => resolve()));
  }

  async unary(path: string, request: Buffer, options: GrpcCallOptions = {}): Promise<Buffer> {
    const messages: Buffer[] = [];
    await this.call(path, request, message => { messages.push(message); }, options);
    if (messages.length !== 1) throw new GrpcError(12, `${path} returned ${messages.length} messages instead of one.`);
    return messages[0];
  }
  serverStream(path: string, request: Buffer, onMessage: (message: Buffer) => void, options: GrpcCallOptions = {}): Promise<void> {
    return this.call(path, request, onMessage, options);
  }
  close(): void { this.session.destroy(); }

  private call(path: string, request: Buffer, onMessage: (message: Buffer) => void, options: GrpcCallOptions): Promise<void> {
    return new Promise((resolve, reject) => {
      if (options.signal?.aborted) { reject(new GrpcError(1, `${path} was cancelled.`)); return; }
      let stream: http2.ClientHttp2Stream;
      try {
        stream = this.session.request({ ":method": "POST", ":path": path, "content-type": "application/grpc", te: "trailers",
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {}), ...(options.timeoutMs ? { "grpc-timeout": `${Math.ceil(options.timeoutMs)}m` } : {}) });
      } catch (error) { reject(new GrpcError(14, `${path}: ${error instanceof Error ? error.message : error}`)); return; }
      let settled = false, status: number | undefined, message = "", pending: Buffer = Buffer.alloc(0);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const abort = () => fail(new GrpcError(1, `${path} was cancelled.`));
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
        if (error) { if (!stream.closed) stream.close(http2.constants.NGHTTP2_CANCEL); reject(error); } else resolve();
      };
      const fail = (error: Error) => finish(error);
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.timeoutMs) timer = setTimeout(() => fail(new GrpcError(4, `${path} exceeded its ${options.timeoutMs} ms deadline.`)), options.timeoutMs);
      const readStatus = (headers: http2.IncomingHttpHeaders) => {
        if (headers["grpc-status"] !== undefined) { status = Number(headers["grpc-status"]); message = decodeMessage(headers["grpc-message"]); }
      };
      stream.on("response", headers => {
        const http = Number(headers[":status"]);
        if (http !== 200) { fail(new GrpcError(HTTP_STATUS[http] ?? 2, `${path} answered HTTP ${http}.`)); return; }
        if (!String(headers["content-type"] ?? "").startsWith("application/grpc")) { fail(new GrpcError(2, `${path} answered ${headers["content-type"]}, not gRPC.`)); return; }
        readStatus(headers);
      });
      stream.on("trailers", readStatus);
      stream.on("data", (chunk: Buffer) => {
        if (settled) return;
        pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
        while (pending.length >= 5) {
          if (pending[0] !== 0) { fail(new GrpcError(13, `${path} sent a compressed message.`)); return; }
          const length = pending.readUInt32BE(1);
          if (length > MAX_MESSAGE) { fail(new GrpcError(8, `${path} sent a ${length}-byte message.`)); return; }
          if (pending.length < 5 + length) return;
          const body = pending.subarray(5, 5 + length);
          pending = pending.subarray(5 + length);
          try { onMessage(body); } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); return; }
        }
      });
      stream.on("error", error => fail(new GrpcError(14, `${path}: ${error.message}`)));
      stream.on("close", () => {
        if (status === undefined) fail(new GrpcError(stream.rstCode && stream.rstCode !== http2.constants.NGHTTP2_NO_ERROR ? 14 : 13, `${path} ended without a gRPC status.`));
        else if (status !== 0) fail(new GrpcError(status, message || `${path} failed with gRPC status ${status}.`));
        else if (pending.length) fail(new GrpcError(13, `${path} ended inside a message.`));
        else finish();
      });
      const header = Buffer.alloc(5);
      header.writeUInt32BE(request.length, 1);
      stream.end(Buffer.concat([header, request]));
    });
  }
}
