import { createServer, type Server } from "node:http";
import { connect, createServer as createNetServer, type AddressInfo, type Socket } from "node:net";
import { afterEach, expect, test } from "vitest";
import { acceptKey, acceptWebSocket, connectWebSocket, encodeFrame, WsConnection, WsUpgradeError } from "../src/ws-lite.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

/** A loopback HTTP server whose upgrades become server-side connections. */
async function server(options: { protocol?: string; refuse?: number } = {}) {
  const accepted: WsConnection[] = [];
  const waiting: ((ws: WsConnection) => void)[] = [];
  const http: Server = createServer((_req, res) => res.end());
  http.on("upgrade", (req, socket, head) => {
    if (options.refuse) { socket.end(`HTTP/1.1 ${options.refuse} Refused\r\nContent-Length: 0\r\n\r\n`); return; }
    const ws = acceptWebSocket(req, socket, head, options.protocol);
    if (!ws) return;
    accepted.push(ws);
    waiting.shift()?.(ws);
  });
  await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
  const port = (http.address() as AddressInfo).port;
  cleanups.push(() => { http.closeAllConnections(); http.close(); });
  const socket = async () => { const s = connect(port, "127.0.0.1"); await new Promise(resolve => s.once("connect", resolve)); return s; };
  const next = () => accepted.length ? Promise.resolve(accepted.shift()!) : new Promise<WsConnection>(resolve => waiting.push(resolve));
  return { port, socket, next };
}
const message = (ws: WsConnection) => new Promise<{ data: Buffer; binary: boolean }>(resolve => ws.once("message", (data, binary) => resolve({ data, binary })));
const closed = (ws: WsConnection) => new Promise<[number, string]>(resolve => ws.once("close", (code, reason) => resolve([code, reason])));

test("text, large and one-byte binary messages travel both ways; the chosen subprotocol is reported", async () => {
  const s = await server({ protocol: "rcdp.v2" });
  const { ws, protocol } = await connectWebSocket(await s.socket(), { host: "localhost", path: "/media?ticket=t", protocols: ["rcdp.v2", "cua.ticket.t"] });
  expect(protocol).toBe("rcdp.v2");
  const peer = await s.next();
  const large = Buffer.alloc(70_000, 7); large[69_999] = 9;
  const received = message(peer);
  ws.send("héllo");
  expect(await received).toEqual({ data: Buffer.from("héllo"), binary: false });
  const big = message(peer); ws.send(large);
  expect(await big).toEqual({ data: large, binary: true });
  const back = message(ws); peer.send(Buffer.from([42]));
  expect(await back).toEqual({ data: Buffer.from([42]), binary: true });
  const both = [closed(ws), closed(peer)];
  ws.close(1000, "done");
  expect(await Promise.all(both)).toEqual([[1000, "done"], [1000, "done"]]);
});

test("messages sent right after the handshake reach listeners attached after awaiting the connection", async () => {
  const http = createServer();
  http.on("upgrade", (req, socket) => {
    // The 101 response and the first frames arrive in one write, as a server pushing hello does.
    const key = String(req.headers["sec-websocket-key"]);
    socket.write(Buffer.concat([Buffer.from(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`),
      encodeFrame(1, Buffer.from("hello"), false), encodeFrame(1, Buffer.from("opened"), false)]));
  });
  await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => { http.closeAllConnections(); http.close(); });
  const socket = connect((http.address() as AddressInfo).port, "127.0.0.1");
  await new Promise(resolve => socket.once("connect", resolve));
  const { ws } = await connectWebSocket(socket, { host: "localhost", path: "/" });
  const got: string[] = [];
  ws.on("message", data => got.push(data.toString()));
  await expect.poll(() => got).toEqual(["hello", "opened"]);
});

test("a fragmented message with an interleaved ping is reassembled and the ping answered", async () => {
  const s = await server();
  const raw = await s.socket();
  const { ws: client } = await connectWebSocket(raw, { host: "localhost", path: "/" });
  const peer = await s.next();
  const pong = new Promise<Buffer>(resolve => client.once("pong", resolve));
  const received = message(peer);
  raw.write(Buffer.concat([encodeFrame(1, Buffer.from("frag"), true, false), encodeFrame(9, Buffer.from("p1"), true),
    encodeFrame(0, Buffer.from("men"), true, false), encodeFrame(0, Buffer.from("ted"), true, true)]));
  expect(await received).toEqual({ data: Buffer.from("fragmented"), binary: false });
  // The server answered the hand-built ping; the client sees its pong.
  expect((await pong).toString()).toBe("p1");
  const second = new Promise<Buffer>(resolve => client.once("pong", resolve));
  client.ping(Buffer.from("p2"));
  expect((await second).toString()).toBe("p2");
});

/** Read the first close frame a peer sends on a raw socket. */
function closeFrame(socket: Socket, skipHead = false) {
  return new Promise<number>(resolve => {
    let bytes = Buffer.alloc(0);
    socket.on("data", chunk => {
      bytes = Buffer.concat([bytes, chunk]);
      let at = skipHead ? bytes.indexOf("\r\n\r\n") + 4 : 0;
      if (skipHead && at < 4) return;
      while (at + 2 <= bytes.length) {
        const length = bytes[at + 1] & 0x7f;
        if ((bytes[at] & 0x0f) === 8 && at + 4 <= bytes.length) { resolve(bytes.readUInt16BE(at + 2)); return; }
        at += 2 + length;
      }
    });
  });
}

test("an unmasked client frame and a masked server frame are protocol errors closing with 1002", async () => {
  const s = await server();
  const raw = await s.socket();
  const key = Buffer.alloc(16, 1).toString("base64");
  raw.write(`GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  const code = closeFrame(raw, true);
  const peer = await s.next();
  const peerClosed = closed(peer);
  raw.write(encodeFrame(1, Buffer.from("unmasked"), false));
  expect(await code).toBe(1002);
  expect((await peerClosed)[0]).toBe(1002);

  const http = createServer();
  http.on("upgrade", (req, socket) => {
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(String(req.headers["sec-websocket-key"]))}\r\n\r\n`);
    const seen = closeFrame(socket as Socket);
    socket.write(encodeFrame(1, Buffer.from("masked"), true));
    void seen.then(value => socket.end(String(value)));
  });
  await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => { http.closeAllConnections(); http.close(); });
  const socket = connect((http.address() as AddressInfo).port, "127.0.0.1");
  await new Promise(resolve => socket.once("connect", resolve));
  const { ws } = await connectWebSocket(socket, { host: "localhost", path: "/" });
  expect((await closed(ws))[0]).toBe(1002);
});

test("a close from the peer is answered with its code; an oversized message closes with 1009", async () => {
  const s = await server();
  const { ws } = await connectWebSocket(await s.socket(), { host: "localhost", path: "/" });
  const peer = await s.next();
  const both = [closed(ws), closed(peer)];
  peer.close(4404, "session closed");
  expect(await Promise.all(both)).toEqual([[4404, "session closed"], [4404, "session closed"]]);

  // A raw peer past the handshake sends 11 bytes to a connection that accepts 10.
  const tcp = createNetServer(socket => { const code = closeFrame(socket); socket.write(encodeFrame(2, Buffer.alloc(11), false)); void code.then(() => socket.end()); });
  await new Promise<void>(resolve => tcp.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => tcp.close());
  const raw = connect((tcp.address() as AddressInfo).port, "127.0.0.1");
  const small = new WsConnection(raw, { client: true, maxMessage: 10 });
  expect((await closed(small))[0]).toBe(1009);
});

test("a refused upgrade rejects with the HTTP status; a bad upgrade request gets 400", async () => {
  const s = await server({ refuse: 401 });
  const error = await connectWebSocket(await s.socket(), { host: "localhost", path: "/media?ticket=x" }).catch(e => e);
  expect(error).toBeInstanceOf(WsUpgradeError);
  expect(error.status).toBe(401);
  expect(error.message).not.toContain("ticket=x");

  const ok = await server();
  const raw = await ok.socket();
  const response = new Promise<string>(resolve => { let text = ""; raw.on("data", c => { text += c; }); raw.on("close", () => resolve(text)); });
  raw.write("GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\n\r\n");
  expect(await response).toMatch(/^HTTP\/1\.1 400/);
});
