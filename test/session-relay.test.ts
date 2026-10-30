import { createHmac, randomBytes } from "node:crypto";
import { createServer as httpServer } from "node:http";
import { once } from "node:events";
import { connect, createServer, type AddressInfo, type Socket } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { expect, test } from "vitest";
import { connectRelay } from "../src/relay-auth.ts";
import { createSessionRelay } from "../src/session-relay.ts";
import { SingleConnectionHttpTransport } from "../src/http-transport.ts";

const keys = () => ({ session: "test-session", clientKey: randomBytes(32).toString("hex"), sessionKey: randomBytes(32).toString("hex") });
const proofContext = (auth: { session: string; key: string }, side: string, channel: string, role: string, serverNonce: unknown, nonce: unknown) =>
  createHmac("sha256", Buffer.from(auth.key, "hex")).update(JSON.stringify(["pi-relay", 1, side, auth.session, channel, role, serverNonce, nonce])).digest("hex");
const line = (socket: Socket): Promise<Record<string, unknown>> => new Promise((resolve, reject) => {
  let text = "";
  const data = (chunk: Buffer) => { text += chunk.toString(); if (text.includes("\n")) { socket.pause(); socket.off("data", data); resolve(JSON.parse(text.split("\n")[0])); } };
  socket.once("error", reject); socket.on("data", data); socket.resume();
});

test("a foreign reverse endpoint cannot enter pairing or receive driver credentials", async () => {
  const k = keys();
  const relay = await createSessionRelay(k, { authenticationTimeoutMs: 100 });
  const attacker = connect(relay.ports[1], "127.0.0.1");
  const stolen: Buffer[] = [];
  attacker.on("data", c => stolen.push(c)); attacker.on("error", () => {});
  const dropped = once(attacker, "close");
  const transport = new SingleConnectionHttpTransport(new URL(`http://127.0.0.1:${relay.ports[0]}/mcp`), "secret-bearer",
    { session: k.session, key: k.clientKey });
  let legitimate: Socket | undefined;
  try {
    const response = transport.send({ jsonrpc: "2.0", id: 1, method: "initialize" });
    await dropped;
    legitimate = await connectRelay(relay.ports[1], { session: k.session, key: k.sessionKey }, { channel: "driver", role: "session" });
    let request = "";
    legitimate.on("data", chunk => {
      request += chunk.toString();
      if (!request.includes("secret-bearer")) return;
      const body = JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} });
      legitimate!.write(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    });
    legitimate.resume();
    await response;
    expect(request).toContain("Authorization: Bearer secret-bearer");
    expect(Buffer.concat(stolen).toString()).not.toContain("secret-bearer");
    expect(Buffer.concat(stolen).toString()).not.toContain("POST /mcp");
  } finally { attacker.destroy(); legitimate?.destroy(); await transport.close(); await relay.close(); }
});

test("successive driver requests keep the same authenticated native TCP connection", async () => {
  let accepted = 0;
  const native = httpServer((request, response) => {
    let body = "";
    request.on("data", chunk => { body += String(chunk); });
    request.on("end", () => {
      const message = JSON.parse(body);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }));
    });
  });
  native.on("connection", () => { accepted++; });
  await new Promise<void>(resolve => native.listen(0, "127.0.0.1", resolve));
  const k = keys(), relay = await createSessionRelay(k);
  const remote = await connectRelay(relay.ports[1], { session: k.session, key: k.sessionKey }, { channel: "driver", role: "session" });
  const local = connect((native.address() as AddressInfo).port, "127.0.0.1");
  remote.pipe(local); local.pipe(remote);
  const transport = new SingleConnectionHttpTransport(new URL(`http://127.0.0.1:${relay.ports[0]}/mcp`), "driver-token",
    { session: k.session, key: k.clientKey });
  const replies: unknown[] = []; transport.onmessage = message => { replies.push(message); };
  try {
    for (const id of [1, 2]) await transport.send({ jsonrpc: "2.0", id, method: "test" });
    expect(replies).toEqual([{ jsonrpc: "2.0", id: 1, result: {} }, { jsonrpc: "2.0", id: 2, result: {} }]);
    expect(accepted).toBe(1);
  } finally {
    await transport.close(); remote.destroy(); local.destroy(); await relay.close();
    native.closeAllConnections(); await new Promise<void>(resolve => native.close(() => resolve()));
  }
});

test("a valid key cannot substitute a different session, role or channel", async () => {
  const k = keys(); const relay = await createSessionRelay(k);
  try {
    for (const [auth, context] of [
      [{ session: k.session, key: k.sessionKey }, { channel: "driver", role: "client" }],
      [{ session: "other-session", key: k.clientKey }, { channel: "driver", role: "client" }],
      [{ session: k.session, key: k.clientKey }, { channel: "identity", role: "client" }],
      [{ session: k.session, key: k.clientKey }, { channel: "driver", role: "session" }],
    ] as const) {
      await expect(connectRelay(relay.ports[0], auth, context)).rejects.toBeInstanceOf(Error);
    }
  } finally { await relay.close(); }
});

test("a server proof coalesced with application bytes preserves every payload byte", async () => {
  const auth = { session: "coalesced-test", key: "ef".repeat(32) };
  const sockets: Socket[] = [];
  const server = createServer(socket => {
    sockets.push(socket); socket.on("error", () => {});
    const nonce = "ab".repeat(32);
    socket.write(JSON.stringify({ version: 1, nonce }) + "\n");
    void line(socket).then(frame => {
      const mac = proofContext(auth, "server", "identity", "client", nonce, frame.nonce);
      socket.write(JSON.stringify({ proof: mac }) + "\n" + "identity-payload\n");
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const peer = await connectRelay((server.address() as AddressInfo).port, auth, { channel: "identity", role: "client" });
    sockets.push(peer);
    const data = once(peer, "data"); peer.resume();
    expect(String((await data)[0])).toBe("identity-payload\n");
  } finally { sockets.forEach(s => s.destroy()); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("oversized unauthenticated frames are dropped without entering a pairing queue", async () => {
  const k = keys(); const relay = await createSessionRelay(k);
  const attacker = connect(relay.ports[1], "127.0.0.1"); attacker.on("error", () => {});
  try {
    await line(attacker);
    const closed = once(attacker, "close");
    attacker.write("x".repeat(513)); attacker.resume();
    await closed;
    expect(attacker.destroyed).toBe(true);
  } finally { attacker.destroy(); await relay.close(); }
});

test("proofs cannot be replayed on another connection, channel or role", async () => {
  const k = keys(); const relay = await createSessionRelay(k);
  const sockets: Socket[] = [];
  try {
    const first = connect(relay.ports[0], "127.0.0.1"); sockets.push(first);
    const challenge = await line(first);
    const nonce = randomBytes(32).toString("hex");
    const proof = createHmac("sha256", Buffer.from(k.clientKey, "hex"))
      .update(JSON.stringify(["pi-relay", 1, "client", k.session, "driver", "client", challenge.nonce, nonce])).digest("hex");
    const frame = { version: 1, session: k.session, channel: "driver", role: "client", nonce, proof };
    const serverProof = line(first); first.write(JSON.stringify(frame) + "\n");
    expect(await serverProof).toHaveProperty("proof");
    for (const port of [relay.ports[0], relay.ports[1], relay.ports[2]]) {
      const replay = connect(port, "127.0.0.1"); replay.on("error", () => {}); sockets.push(replay);
      await line(replay);
      const closed = once(replay, "close"); replay.write(JSON.stringify(frame) + "\n"); replay.resume();
      await closed;
      expect(replay.destroyed).toBe(true);
    }
  } finally { sockets.forEach(s => s.destroy()); await relay.close(); }
});

test("an idle driver handshake does not block identity and authenticated peers survive idle time", async () => {
  const k = keys(); const relay = await createSessionRelay(k, { authenticationTimeoutMs: 80 });
  const idle = connect(relay.ports[1], "127.0.0.1"); idle.on("error", () => {});
  const sockets: Socket[] = [idle];
  try {
    const session = await connectRelay(relay.ports[3], { session: k.session, key: k.sessionKey }, { channel: "identity", role: "session" }); sockets.push(session);
    const client = await connectRelay(relay.ports[2], { session: k.session, key: k.clientKey }, { channel: "identity", role: "client" }); sockets.push(client);
    await delay(180);
    const reply = once(client, "data"); client.resume();
    session.write("persistent-identity-response\n"); session.resume();
    expect(String((await reply)[0])).toBe("persistent-identity-response\n");
    await relay.close();
    await expect(connectRelay(relay.ports[0], { session: k.session, key: k.clientKey }, { channel: "driver", role: "client" })).rejects.toBeInstanceOf(Error);
  } finally { sockets.forEach(s => s.destroy()); await relay.close(); }
});
