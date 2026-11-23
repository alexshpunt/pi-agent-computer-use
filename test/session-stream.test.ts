import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer as http1Server, type IncomingMessage } from "node:http";
import { createServer as http2Server, type ServerHttp2Stream, type IncomingHttpHeaders } from "node:http2";
import { connect, createServer, type AddressInfo, type Socket } from "node:net";
import { afterEach, expect, test } from "vitest";
import { ProtoWriter, decodeProto, type ProtoMessage } from "../src/grpc-lite.ts";
import { createStreamHub, type StreamHub } from "../src/session-stream.ts";
import { acceptWebSocket, connectWebSocket, type WsConnection } from "../src/ws-lite.ts";

const SPACESD = randomBytes(32).toString("hex"), VIEWER = randomBytes(32).toString("hex");
const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const grpcFrame = (message: Buffer) => { const head = Buffer.alloc(5); head.writeUInt32BE(message.length, 1); return Buffer.concat([head, message]); };
const windowInfo = (id: string, title: string, pid: number, bounds: number[], z: number) => new ProtoWriter()
  .message(1, new ProtoWriter().string(1, id).uint(2, 3)).string(2, title).message(3, new ProtoWriter().string(1, "App").uint(3, pid))
  .message(4, new ProtoWriter().double(1, bounds[0]).double(2, bounds[1]).double(3, bounds[2]).double(4, bounds[3])).uint(6, 1).uint(7, 1).bool(9, true).uint(10, z);

/** One port, like cua-spacesd: h2c gRPC and the HTTP/1.1 /media WebSocket, told apart by the connection preface. */
async function fakeSpacesd(options: { holdUpgrade?: Promise<void>; failOpen?: number } = {}) {
  const calls: { method: string; auth?: string; request: ProtoMessage }[] = [];
  const media: { path: string; ws: WsConnection; received: Record<string, unknown>[]; closed: boolean }[] = [];
  let upgrades = 0;
  let watch: ServerHttp2Stream | undefined;
  const h2 = http2Server();
  h2.on("stream", (stream: ServerHttp2Stream, headers: IncomingHttpHeaders) => {
    const method = String(headers[":path"]).split("/").pop()!;
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", () => {
      const request = decodeProto(Buffer.concat(chunks).subarray(5));
      calls.push({ method, auth: headers.authorization as string | undefined, request });
      if (headers.authorization !== `Bearer ${SPACESD}`) { stream.respond({ ":status": 200, "content-type": "application/grpc", "grpc-status": "16" }, { endStream: true }); return; }
      if (method === "OpenMedia" && calls.filter(c => c.method === "OpenMedia").length <= (options.failOpen ?? 0)) {
        stream.respond({ ":status": 200, "content-type": "application/grpc", "grpc-status": "14", "grpc-message": "capture unavailable" }, { endStream: true });
        return;
      }
      stream.respond({ ":status": 200, "content-type": "application/grpc" }, { waitForTrailers: true });
      stream.on("wantTrailers", () => stream.sendTrailers({ "grpc-status": "0" }));
      if (method === "WatchWindows") {
        watch = stream;
        stream.write(grpcFrame(new ProtoWriter().message(1, new ProtoWriter()
          .message(1, windowInfo("w-a", "Alpha", 7, [10, 20, 300, 200], 0)).message(1, windowInfo("w-b", "Beta", 8, [400, 20, 200, 100], 1))).finish()));
        return;
      }
      const reply = method === "OpenMedia" ? new ProtoWriter().string(1, `m-${calls.filter(c => c.method === "OpenMedia").length}`).string(2, "t")
        .string(4, `/media?ticket=t${calls.length}`).uint(6, 1).uint(7, request.uint(3)).uint(8, request.uint(4)) : new ProtoWriter();
      stream.end(grpcFrame(reply.finish()));
    });
  });
  const h1 = http1Server();
  h1.on("upgrade", async (req: IncomingMessage, socket: Socket, head: Buffer) => {
    upgrades++;
    await options.holdUpgrade;
    const ws = acceptWebSocket(req, socket, head, "rcdp.v2")!;
    const entry = { path: req.url!, ws, received: [] as Record<string, unknown>[], closed: false };
    ws.on("message", (data: Buffer) => entry.received.push(JSON.parse(data.toString())));
    ws.on("close", () => { entry.closed = true; });
    media.push(entry);
    ws.send(JSON.stringify({ type: "hello", payload: { protocol: "rcdp", versions: [2], selected_version: 2, capabilities: [] } }));
  });
  const server = createServer(socket => {
    socket.once("readable", () => {
      const first = socket.read() as Buffer | null;
      if (!first) return;
      socket.unshift(first);
      (first.toString("latin1").startsWith("PRI * HTTP/2.0") ? h2 : h1).emit("connection", socket);
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const sockets = new Set<Socket>();
  server.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  cleanups.push(() => { for (const socket of sockets) socket.destroy(); return new Promise(resolve => server.close(resolve)); });
  const port = (server.address() as AddressInfo).port;
  return {
    calls, media, port, upgrades: () => upgrades,
    connect: async () => { const socket = connect(port, "127.0.0.1"); await once(socket, "connect"); return socket; },
    watchEvent: (field: number, message: ProtoWriter) => watch!.write(grpcFrame(new ProtoWriter().message(field, message).finish())),
    /** A video packet as spacesd sends it: u32 header length, u32 payload length, enveloped JSON descriptor, payload. */
    frame: (index: number, sequence: number, keyframe: boolean, payload: Buffer) => {
      const header = Buffer.from(JSON.stringify({ direction: "video", message: { session_id: `m-${index + 1}`, sequence, geometry_epoch: 1, codec_epoch: 1,
        width_px: 300, height_px: 200, capture_timestamp_us: 1000 + sequence, codec: "h264", keyframe } }));
      const prefix = Buffer.alloc(8); prefix.writeUInt32BE(header.length, 0); prefix.writeUInt32BE(payload.length, 4);
      media[index].ws.send(Buffer.concat([prefix, header, payload]));
    },
  };
}

async function hubFor(spacesd: Awaited<ReturnType<typeof fakeSpacesd>>, accept?: (pid: number) => boolean): Promise<StreamHub> {
  const hub = await createStreamHub({ session: "is-test", spacesdToken: SPACESD, viewerToken: VIEWER, connect: spacesd.connect, ...(accept ? { accept } : {}) });
  cleanups.push(() => hub.close());
  return hub;
}

/** A tile host: every text message and binary frame it receives, in order. */
async function viewer(hub: StreamHub, token = VIEWER) {
  const socket = connect(hub.port, "127.0.0.1"); await once(socket, "connect");
  const { ws } = await connectWebSocket(socket, { host: "127.0.0.1", path: `/v1/stream?token=${token}` });
  const messages: Record<string, unknown>[] = [];
  const frames: { header: Record<string, unknown>; payload: Buffer }[] = [];
  ws.on("message", (data: Buffer, binary: boolean) => {
    if (!binary) { messages.push(JSON.parse(data.toString())); return; }
    const length = data.readUInt32BE(0);
    frames.push({ header: JSON.parse(data.subarray(4, 4 + length).toString()), payload: data.subarray(4 + length) });
  });
  cleanups.push(() => ws.close());
  return { ws, messages, frames, send: (message: unknown) => ws.send(JSON.stringify(message)) };
}

const until = async (check: () => unknown, what = "condition") => {
  for (let i = 0; i < 200; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error(`Timed out waiting for ${what}.`);
};

test("a viewer needs the token; windows stream only while someone watches", async () => {
  const spacesd = await fakeSpacesd();
  const hub = await hubFor(spacesd);
  const socket = connect(hub.port, "127.0.0.1"); await once(socket, "connect");
  await expect(connectWebSocket(socket, { host: "127.0.0.1", path: "/v1/stream?token=" + "0".repeat(64) })).rejects.toThrow(/401/);
  expect(spacesd.calls).toEqual([]);

  const tile = await viewer(hub);
  await until(() => tile.messages.some(m => m.type === "windows"), "the window list");
  expect(tile.messages[0]).toMatchObject({ type: "hello", version: 1, session: "is-test", windows: [], activity: null });
  expect(tile.messages.find(m => m.type === "windows")!.windows).toEqual([
    { id: "w-a", title: "Alpha", app: "App", pid: 7, bounds: { x: 10, y: 20, width: 300, height: 200 }, state: "normal", kind: "standard", focused: false, onScreen: true, z: 0 },
    { id: "w-b", title: "Beta", app: "App", pid: 8, bounds: { x: 400, y: 20, width: 200, height: 100 }, state: "normal", kind: "standard", focused: false, onScreen: true, z: 1 },
  ]);
  expect(spacesd.calls.map(c => [c.method, c.auth])).toEqual([["WatchWindows", `Bearer ${SPACESD}`]]);

  spacesd.watchEvent(3, windowInfo("w-b", "Beta renamed", 8, [400, 20, 200, 100], 1));
  await until(() => tile.messages.filter(m => m.type === "windows").length === 2, "the update");
  expect((tile.messages.at(-1)!.windows as { title: string }[])[1].title).toBe("Beta renamed");

  // A request of an unknown type is refused, not taken for a subscription.
  tile.send({ type: "watch", window: "w-a" });
  await until(() => tile.messages.some(m => m.type === "error"), "the refusal");
  expect(tile.messages.find(m => m.type === "error")!.message).toMatch(/watch/);
  expect(spacesd.calls.map(c => c.method)).toEqual(["WatchWindows"]);
});

test("a subscribed window streams from its first keyframe, acks every frame and closes when nobody watches", async () => {
  const spacesd = await fakeSpacesd();
  const hub = await hubFor(spacesd);
  const tile = await viewer(hub);
  await until(() => tile.messages.some(m => m.type === "windows"));
  tile.send({ type: "subscribe", window: "w-a", maxFps: 12, maxDimension: 480 });
  await until(() => spacesd.media.length === 1, "the media socket");
  const open = spacesd.calls.find(c => c.method === "OpenMedia")!.request;
  expect(open.msg(1)!.msg(2)!.str(1)).toBe("w-a");
  expect(open.msg(1)!.msg(2)!.uint(2)).toBe(3);
  expect([open.uints(2), open.uint(3), open.uint(4), open.uint(6)]).toEqual([[1], 12, 480, 1]);
  expect(spacesd.media[0].path).toBe("/media?ticket=t2");
  await until(() => tile.messages.some(m => m.type === "stream"));
  expect(tile.messages.find(m => m.type === "stream")).toEqual({ type: "stream", window: "w-a", state: "open", codec: "h264", maxFps: 12, maxDimension: 480 });

  spacesd.frame(0, 5, false, Buffer.from("delta-before-key"));
  spacesd.frame(0, 6, true, Buffer.from([0, 0, 0, 1, 0x67, 1, 2]));
  spacesd.frame(0, 7, false, Buffer.from([0, 0, 0, 1, 0x41, 9]));
  await until(() => tile.frames.length === 2, "two frames");
  expect(tile.frames.map(f => f.header)).toEqual([
    { window: "w-a", sequence: 6, keyframe: true, width: 300, height: 200, timestampUs: 1006 },
    { window: "w-a", sequence: 7, keyframe: false, width: 300, height: 200, timestampUs: 1007 },
  ]);
  expect(tile.frames[0].payload).toEqual(Buffer.from([0, 0, 0, 1, 0x67, 1, 2]));
  await until(() => spacesd.media[0].received.filter(m => m.type === "frame_ack").length === 3, "acks");
  expect(spacesd.media[0].received.filter(m => m.type === "frame_ack").map(m => m.payload))
    .toEqual([5, 6, 7].map(sequence => ({ session_id: "m-1", sequence })));

  // A second viewer raises the rate and waits for a fresh keyframe.
  const other = await viewer(hub);
  other.send({ type: "subscribe", window: "w-a", maxFps: 30, maxDimension: 320 });
  await until(() => spacesd.calls.some(c => c.method === "SetPreferences"), "new preferences");
  const preferences = spacesd.calls.find(c => c.method === "SetPreferences")!.request;
  expect([preferences.str(1), preferences.uint(2), preferences.uint(3)]).toEqual(["m-1", 30, 480]);
  await until(() => spacesd.media[0].received.some(m => m.type === "request_keyframe"), "a keyframe request");
  spacesd.frame(0, 8, false, Buffer.from("delta"));
  spacesd.frame(0, 9, true, Buffer.from("key"));
  await until(() => other.frames.length === 1 && tile.frames.length === 4, "fan-out");
  expect(other.frames[0].header.sequence).toBe(9);

  tile.send({ type: "unsubscribe", window: "w-a" });
  other.send({ type: "unsubscribe", window: "w-a" });
  await until(() => spacesd.calls.some(c => c.method === "CloseMedia"), "CloseMedia");
  expect(spacesd.calls.find(c => c.method === "CloseMedia")!.request.str(1)).toBe("m-1");
});

test("the agent's activity names the window it happened in and a closed window ends its stream", async () => {
  const spacesd = await fakeSpacesd();
  const hub = await hubFor(spacesd);
  const tile = await viewer(hub);
  await until(() => tile.messages.some(m => m.type === "windows"));
  const post = (body: unknown, token = VIEWER) => fetch(`http://127.0.0.1:${hub.port}/v1/activity`,
    { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  expect((await post({ pid: 7, kind: "action" }, "1".repeat(64))).status).toBe(401);
  expect((await post({ pid: 7, kind: "action", bounds: { x: 0, y: 0, width: 1, height: 1 }, action: "x".repeat(65) })).status).toBe(400);
  const ok = await post({ pid: 7, kind: "action", bounds: { x: 11, y: 20, width: 300, height: 199 }, point: { x: 40, y: 60 }, action: "click", outcome: "delivered" });
  expect(ok.status).toBe(204);
  await until(() => tile.messages.some(m => m.type === "activity"));
  expect(tile.messages.find(m => m.type === "activity")).toMatchObject({ type: "activity", window: "w-a", pid: 7, kind: "action", action: "click", outcome: "delivered", point: { x: 40, y: 60 } });

  // An element action has only a region: the cursor goes to its centre, in the window under it.
  expect((await post({ pid: 8, kind: "action", bounds: { x: 0, y: 0, width: 5, height: 5 }, region: { x: 420, y: 40, width: 40, height: 20 }, action: "click" })).status).toBe(204);
  await until(() => tile.messages.filter(m => m.type === "activity").length === 2);
  expect(tile.messages.filter(m => m.type === "activity")[1]).toMatchObject({ window: "w-b", point: { x: 440, y: 50 }, region: { x: 420, y: 40, width: 40, height: 20 } });
  expect((await post({ pid: 7, kind: "action", bounds: { x: 11, y: 20, width: 300, height: 199 }, point: { x: 40, y: 60 }, action: "click" })).status).toBe(204);

  // A new viewer gets the latest activity in its hello.
  const late = await viewer(hub);
  await until(() => late.messages.length > 0);
  expect(late.messages[0].activity).toMatchObject({ window: "w-a", action: "click" });

  tile.send({ type: "subscribe", window: "w-b" });
  await until(() => spacesd.media.length === 1);
  spacesd.watchEvent(4, new ProtoWriter().message(1, new ProtoWriter().string(1, "w-b").uint(2, 3)));
  await until(() => tile.messages.some(m => m.type === "stream" && m.state === "ended"), "the end of the stream");
  expect(tile.messages.find(m => m.type === "stream" && m.state === "ended")).toEqual({ type: "stream", window: "w-b", state: "ended", reason: "window closed" });
  tile.send({ type: "subscribe", window: "w-b" });
  await until(() => tile.messages.some(m => m.type === "error"));
  expect(tile.messages.find(m => m.type === "error")!.message).toMatch(/No window w-b/);
});

// LPT-1809: in a sandbox other agents share, an agent's tiles show only the windows of the apps it started.
test("a hub of a shared desktop shows only the agent's own processes, and a process it starts later after its next activity", async () => {
  const spacesd = await fakeSpacesd();
  const mine = new Set([7]);
  const hub = await hubFor(spacesd, pid => mine.has(pid));
  const tile = await viewer(hub);
  await until(() => tile.messages.some(m => m.type === "windows"), "the window list");
  expect((tile.messages.find(m => m.type === "windows")!.windows as { id: string }[]).map(window => window.id)).toEqual(["w-a"]);
  tile.send({ type: "subscribe", window: "w-b" });
  await until(() => tile.messages.some(m => m.type === "error"), "the refusal");
  expect(spacesd.media).toEqual([]);

  // The agent starts the process of w-b and looks at it: the next window list includes it.
  mine.add(8);
  const post = await fetch(`http://127.0.0.1:${hub.port}/v1/activity`, { method: "POST", headers: { authorization: `Bearer ${VIEWER}` },
    body: JSON.stringify({ pid: 8, kind: "overview", bounds: { x: 400, y: 20, width: 200, height: 100 } }) });
  expect(post.status).toBe(204);
  await until(() => tile.messages.filter(m => m.type === "windows").length === 2, "the new list");
  expect((tile.messages.filter(m => m.type === "windows").at(-1)!.windows as { id: string }[]).map(window => window.id)).toEqual(["w-a", "w-b"]);
  expect(tile.messages.find(m => m.type === "activity")).toMatchObject({ window: "w-b", pid: 8 });
});

test("a viewer that leaves while its window's media socket opens leaves no capture running", async () => {
  let release!: () => void;
  const spacesd = await fakeSpacesd({ holdUpgrade: new Promise<void>(resolve => { release = resolve; }) });
  const hub = await hubFor(spacesd);
  const tile = await viewer(hub);
  await until(() => tile.messages.some(m => m.type === "windows"));
  tile.send({ type: "subscribe", window: "w-a" });
  await until(() => spacesd.upgrades() === 1, "the media upgrade");
  tile.send({ type: "unsubscribe", window: "w-a" });
  await new Promise(resolve => setTimeout(resolve, 50));
  release();
  await until(() => spacesd.media.length === 1 && spacesd.media[0].closed, "the media socket to close");
  await until(() => spacesd.calls.some(c => c.method === "CloseMedia"), "CloseMedia");
});

test("a stream that fails to open tells its viewers and retries", async () => {
  const spacesd = await fakeSpacesd({ failOpen: 1 });
  const hub = await hubFor(spacesd);
  const tile = await viewer(hub);
  await until(() => tile.messages.some(m => m.type === "windows"));
  tile.send({ type: "subscribe", window: "w-a" });
  await until(() => tile.messages.some(m => m.type === "stream" && m.state === "open"), "the stream after a retry");
  expect(tile.messages.filter(m => m.type === "stream").map(m => [m.state, m.reason])).toEqual([["retrying", "capture unavailable"], ["open", undefined]]);
  expect(spacesd.calls.filter(c => c.method === "OpenMedia")).toHaveLength(2);
});
