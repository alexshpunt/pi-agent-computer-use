import { createServer, type AddressInfo, type Socket } from "node:net";
import { once } from "node:events";
import { expect, test } from "vitest";
import { SingleConnectionHttpTransport } from "../src/http-transport.ts";

test("closing during authentication cancels the pending HTTP request and releases its socket", async () => {
  let accepted: (socket: Socket) => void;
  const incoming = new Promise<Socket>(resolve => { accepted = resolve; });
  const server = createServer(socket => { socket.on("error", () => {}); accepted(socket); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const transport = new SingleConnectionHttpTransport(new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`), "private-bearer",
    { session: "cancellation-test", key: "cd".repeat(32) });
  const result = transport.send({ jsonrpc: "2.0", id: 1, method: "initialize" }).then(() => false, () => true);
  const socket = await incoming;
  const closed = once(socket, "close"); socket.resume();
  try {
    await transport.close();
    expect(await result).toBe(true);
    await closed;
    expect(socket.destroyed).toBe(true);
  } finally {
    socket.destroy(); await transport.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("a false relay cannot receive the driver bearer before proving its identity", async () => {
  const sockets = new Set<Socket>();
  const received: Buffer[] = [];
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.write(JSON.stringify({ version: 1, nonce: "ab".repeat(32) }) + "\n");
    socket.on("data", chunk => {
      received.push(chunk);
      // An unauthenticated OK or made-up server proof must never unlock HTTP.
      socket.end(JSON.stringify({ proof: "00".repeat(32) }) + "\n");
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const bearer = "private-driver-token-must-not-reach-the-false-peer";
  const transport = new SingleConnectionHttpTransport(new URL(`http://127.0.0.1:${port}/mcp`), bearer,
    { session: "test-session", key: "cd".repeat(32) });
  try {
    await expect(transport.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })).rejects.toBeInstanceOf(Error);
    expect(Buffer.concat(received).toString()).not.toContain(bearer);
    expect(Buffer.concat(received).toString()).not.toContain("Authorization:");
  } finally {
    await transport.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
