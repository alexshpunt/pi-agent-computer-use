import { createServer, type AddressInfo, type Socket } from "node:net";
import { expect, test } from "vitest";
import { createInterface } from "node:readline";
import { acceptRelaySocket } from "../src/relay-auth.ts";
import { McpDriver } from "../src/driver.ts";

test("Sandbox identity uses its own credential and keeps one persistent peer until close", async () => {
  const auth = { session: "sandbox-test", key: "cd".repeat(32) };
  const sockets = new Set<Socket>(); let accepted = 0, requests = 0, closed = 0;
  let reportClosed: () => void;
  const peerClosed = new Promise<void>(resolve => { reportClosed = resolve; });
  const server = createServer(socket => {
    accepted++; sockets.add(socket); socket.on("error", () => {});
    socket.on("close", () => { sockets.delete(socket); closed++; reportClosed(); });
    void acceptRelaySocket(socket, auth, { channel: "identity", role: "client" }).then(() => {
      createInterface({ input: socket }).on("line", line => {
        const request = JSON.parse(line); requests++;
        socket.write(JSON.stringify({ identity: request.window_id === 123 && request.pid === 456 ? "private-marker" : null }) + "\n");
      });
    }, () => socket.destroy());
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const driver = new McpDriver({ command: "unused.exe", endpoint: { url: "http://127.0.0.1:1/mcp", token: "unused",
    identityPort: (server.address() as AddressInfo).port, identityAuth: auth, relay: { session: auth.session, key: "ef".repeat(32) } } });
  try {
    expect(await driver.identity({ window_id: 123, pid: 456 }, true)).toBe("private-marker");
    expect(await driver.identity({ window_id: 123, pid: 456 }, false)).toBe("private-marker");
    expect(accepted).toBe(1); expect(requests).toBe(2);
    await driver.close(); await peerClosed; expect(closed).toBe(1);
  } finally {
    await driver.close(); sockets.forEach(s => s.destroy());
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("a false Sandbox identity endpoint receives no window request before proving its identity", async () => {
  const sockets = new Set<Socket>(), received: Buffer[] = [];
  const server = createServer(socket => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket)); socket.on("error", () => {});
    socket.write(JSON.stringify({ version: 1, nonce: "ab".repeat(32) }) + "\n");
    socket.on("data", chunk => { received.push(chunk); socket.end(JSON.stringify({ proof: "00".repeat(32) }) + "\n"); });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const driver = new McpDriver({ command: "unused.exe", endpoint: { url: "http://127.0.0.1:1/mcp", token: "unused", identityPort: port,
    identityAuth: { session: "sandbox-test", key: "cd".repeat(32) } } });
  try {
    await expect(driver.identity({ window_id: 123, pid: 456 }, true)).rejects.toBeInstanceOf(Error);
    expect(Buffer.concat(received).toString()).not.toContain('"window_id"');
  } finally {
    await driver.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
