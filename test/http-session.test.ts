import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test } from "vitest";
import { SingleConnectionHttpTransport } from "../src/http-transport.ts";

// Cua Driver 0.52 serves Streamable HTTP sessions: `initialize` mints an Mcp-Session-Id, and every later request
// must name it or the driver refuses with HTTP 400.
test("requests after initialize name the session the driver minted", async () => {
  const seen: (string | undefined)[] = [];
  const server = createServer((request: IncomingMessage, response) => {
    let body = "";
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      const message = JSON.parse(body) as { id: number; method: string };
      const session = request.headers["mcp-session-id"] as string | undefined;
      seen.push(session);
      if (message.method !== "initialize" && session !== "minted-session") {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32600, message: "Missing Mcp-Session-Id" } }));
        return;
      }
      response.writeHead(200, { "Content-Type": "application/json", ...(message.method === "initialize" ? { "Mcp-Session-Id": "minted-session" } : {}) });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const transport = new SingleConnectionHttpTransport(new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`), "bearer");
  const replies: unknown[] = [];
  transport.onmessage = message => replies.push(message);
  try {
    await transport.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    await transport.send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    expect(seen).toEqual([undefined, "minted-session"]);
    expect(replies).toHaveLength(2);
  } finally {
    await transport.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
