import http2 from "node:http2";
import { connect, type AddressInfo } from "node:net";
import { afterEach, expect, test } from "vitest";
import { decodeProto, GrpcClient, GrpcError, ProtoWriter } from "../src/grpc-lite.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

test("protobuf fields round trip: UTF-8 strings, large varints, doubles, nested and repeated messages", () => {
  const nested = new ProtoWriter().string(1, "окно ✓").uint(2, 7);
  const bytes = new ProtoWriter().string(1, "a").uint(2, 2n ** 40n + 3n).double(3, -12.5).bool(4, true)
    .message(5, nested).message(5, new ProtoWriter().string(1, "second")).message(6, Buffer.alloc(0))
    .packed(7, [1, 300, 2 ** 35]).uint(8, 9).uint(8, 10).uint(9, 0).string(10, "").finish();
  const m = decodeProto(bytes);
  expect(m.str(1)).toBe("a");
  expect(m.uint(2)).toBe(2 ** 40 + 3);
  expect(m.big(2)).toBe(2n ** 40n + 3n);
  expect(m.double(3)).toBe(-12.5);
  expect(m.bool(4)).toBe(true);
  expect(m.msg(5)?.str(1)).toBe("second");
  expect(m.msgs(5).map(x => x.str(1))).toEqual(["окно ✓", "second"]);
  expect(m.msgs(5)[0].uint(2)).toBe(7);
  expect(m.has(6)).toBe(true);
  expect(m.msg(6)?.str(1)).toBe("");
  expect(m.uints(7)).toEqual([1, 300, 2 ** 35]);
  expect(m.uints(8)).toEqual([9, 10]);
  expect(m.uint(8)).toBe(10);
  // Proto3 skips zero and empty scalars; missing fields read as defaults.
  expect(m.has(9) || m.has(10)).toBe(false);
  expect([m.uint(99), m.str(99), m.bool(99), m.double(99), m.msg(99), m.bytes(99)]).toEqual([0, "", false, 0, undefined, undefined]);
});

test("unknown fields of every wire type are skipped and malformed input throws", () => {
  const fixed32 = Buffer.from([(11 << 3) | 5, 1, 2, 3, 4]);
  // Field 300 needs a two-byte tag.
  const fixed64 = Buffer.from([0xe1, 0x12, 1, 2, 3, 4, 5, 6, 7, 8]);
  const bytes = Buffer.concat([fixed32, new ProtoWriter().uint(22, 5).string(23, "x").finish(), fixed64, new ProtoWriter().string(1, "kept").finish()]);
  expect(decodeProto(bytes).str(1)).toBe("kept");
  const message = new ProtoWriter().string(1, "hello").finish();
  expect(() => decodeProto(message.subarray(0, message.length - 1))).toThrow(/Truncated/);
  expect(() => decodeProto(Buffer.from([0x08, 0x80]))).toThrow(/varint/);
  expect(() => decodeProto(Buffer.from([0x0b]))).toThrow(/wire type 3/);
});

/** An h2c gRPC server the client reaches through a socket it connects itself, as through an authenticated relay. */
async function server(handler: (stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders, request: Buffer) => void) {
  const seen: http2.IncomingHttpHeaders[] = [];
  const h2 = http2.createServer();
  h2.on("stream", (stream, headers) => {
    seen.push(headers);
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", () => handler(stream, headers, Buffer.concat(chunks).subarray(5)));
    stream.on("error", () => {});
  });
  await new Promise<void>(resolve => h2.listen(0, "127.0.0.1", resolve));
  const socket = connect((h2.address() as AddressInfo).port, "127.0.0.1");
  await new Promise(resolve => socket.once("connect", resolve));
  const client = new GrpcClient(socket, { token: "secret" });
  cleanups.push(() => { client.close(); h2.close(); });
  return { client, seen };
}
const frame = (message: Buffer) => { const head = Buffer.alloc(5); head.writeUInt32BE(message.length, 1); return Buffer.concat([head, message]); };

test("unary call sends the bearer token and returns the one message; split and coalesced frames are reassembled", async () => {
  const { client, seen } = await server((stream, _headers, request) => {
    stream.respond({ ":status": 200, "content-type": "application/grpc" }, { waitForTrailers: true });
    const reply = frame(new ProtoWriter().string(1, `echo ${decodeProto(request).str(1)}`).finish());
    stream.write(reply.subarray(0, 3));
    stream.write(reply.subarray(3));
    stream.on("wantTrailers", () => stream.sendTrailers({ "grpc-status": "0" }));
    stream.end();
  });
  const reply = await client.unary("/cua.env.v1.Test/Echo", new ProtoWriter().string(1, "hi").finish());
  expect(decodeProto(reply).str(1)).toBe("echo hi");
  expect(seen[0].authorization).toBe("Bearer secret");
  expect(seen[0][":path"]).toBe("/cua.env.v1.Test/Echo");
  expect(seen[0]["content-type"]).toBe("application/grpc");
});

test("a server stream delivers each message, then resolves; an error status in trailers rejects with its code and message", async () => {
  const { client } = await server((stream, headers) => {
    stream.respond({ ":status": 200, "content-type": "application/grpc" }, { waitForTrailers: true });
    stream.write(Buffer.concat([1, 2, 3].map(n => frame(new ProtoWriter().uint(1, n).finish()))));
    const failing = headers[":path"] === "/fail";
    stream.on("wantTrailers", () => stream.sendTrailers(failing ? { "grpc-status": "9", "grpc-message": "window%20is%20gone" } : { "grpc-status": "0" }));
    stream.end();
  });
  const got: number[] = [];
  await client.serverStream("/ok", Buffer.alloc(0), message => got.push(decodeProto(message).uint(1)));
  expect(got).toEqual([1, 2, 3]);
  const error = await client.serverStream("/fail", Buffer.alloc(0), () => {}).catch(e => e);
  expect(error).toBeInstanceOf(GrpcError);
  expect(error).toMatchObject({ code: 9, message: "window is gone" });
});

test("a trailers-only error and a non-gRPC HTTP status reject with gRPC codes", async () => {
  const { client } = await server((stream, headers) => {
    if (headers[":path"] === "/denied") stream.respond({ ":status": 401 }, { endStream: true });
    else stream.respond({ ":status": 200, "content-type": "application/grpc", "grpc-status": "16", "grpc-message": "bad token" }, { endStream: true });
  });
  await expect(client.unary("/only", Buffer.alloc(0))).rejects.toMatchObject({ code: 16, message: "bad token" });
  await expect(client.unary("/denied", Buffer.alloc(0))).rejects.toMatchObject({ code: 16, message: expect.stringContaining("HTTP 401") });
});

test("aborting a server stream cancels it on the server; a deadline rejects with DEADLINE_EXCEEDED", async () => {
  let cancelled = false;
  const { client } = await server(stream => {
    stream.respond({ ":status": 200, "content-type": "application/grpc" });
    stream.write(frame(new ProtoWriter().uint(1, 1).finish()));
    stream.on("close", () => { cancelled = true; });
  });
  const controller = new AbortController();
  const done = client.serverStream("/watch", Buffer.alloc(0), () => controller.abort(), { signal: controller.signal });
  await expect(done).rejects.toMatchObject({ code: 1 });
  await expect.poll(() => cancelled).toBe(true);
  await expect(client.unary("/slow", Buffer.alloc(0), { timeoutMs: 50 })).rejects.toMatchObject({ code: 4 });
  // The session survives a cancelled stream.
  const state = () => Promise.race([client.closed.then(() => "closed"), new Promise(resolve => setTimeout(() => resolve("open"), 20))]);
  expect(await state()).toBe("open");
  client.close();
  expect(await state()).toBe("closed");
});
