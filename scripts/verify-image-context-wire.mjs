#!/usr/bin/env node
/** Exercise the installed native Codex cached-WebSocket serializer against a loopback peer. No credentials or paid model calls. */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import sharp from "sharp";
import { createRequire } from "node:module";
import path from "node:path";
import { createHash } from "node:crypto";
import { stream, closeOpenAICodexWebSocketSessions } from "@earendil-works/pi-ai/api/openai-codex-responses";
const { WebSocketServer } = createRequire(import.meta.url)("ws");
const directory = path.resolve(".tmp/image-context/wire"); await mkdir(directory, { recursive: true });
const peer = new WebSocketServer({ host: "127.0.0.1", port: 0 });
await new Promise(resolve => peer.once("listening", resolve));
const records = []; const previous = new Map(); let counter = 0;
const images = input => [...JSON.stringify(input).matchAll(/data:image\/(?:png|jpeg);base64,([A-Za-z0-9+/=]+)/g)].map(match => match[1]);
peer.on("connection", socket => socket.on("message", data => {
  const body = JSON.parse(String(data));
  const effective = body.previous_response_id ? [...previous.get(body.previous_response_id), ...body.input] : body.input;
  const id = `resp-${++counter}`; const item = { id: `msg-${counter}`, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "OK", annotations: [] }] };
  previous.set(id, [...effective, item]);
  records.push({ chained: !!body.previous_response_id, imageCount: images(effective).length,
    hashes: images(effective).map(image => createHash("sha256").update(Buffer.from(image, "base64")).digest("hex")), explicitImageCount: images(body.input).length });
  for (const event of [
    { type: "response.created", response: { id, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
    { type: "response.content_part.added", output_index: 0, item_id: item.id, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
    { type: "response.output_text.delta", output_index: 0, item_id: item.id, content_index: 0, delta: "OK" },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id, status: "completed", output: [item], usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } },
  ]) socket.send(JSON.stringify(event));
}));
const sessionId = "image-wire-contract";
const token = `test.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "loopback-only" } })).toString("base64url")}.test`;
const model = { id: "fixture", provider: "openai-codex", api: "openai-codex-responses", name: "Local wire fixture",
  baseUrl: `http://127.0.0.1:${peer.address().port}/backend-api`, reasoning: false, input: ["text", "image"],
  contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
let messages = [];
const synthetic = await Promise.all(Array.from({ length: 12 }, async (_, n) => {
  const png = await sharp({ create: { width: 16, height: 12, channels: 3, background: { r: n * 10, g: 100, b: 50 } } }).png().toBuffer();
  return { type: "image", mimeType: "image/png", data: png.toString("base64") };
}));
const image = n => synthetic[n];
async function request() {
  const expected = messages.flatMap(message => Array.isArray(message.content) ? message.content.filter(block => block.type === "image") : [])
    .map(image => createHash("sha256").update(Buffer.from(image.data, "base64")).digest("hex"));
  const result = await stream(model, { systemPrompt: "Local image retention contract", messages }, {
    apiKey: token, sessionId, transport: "websocket-cached", cacheRetention: "short", timeoutMs: 2000, websocketConnectTimeoutMs: 2000,
  }).result();
  assert.equal(result.stopReason, "stop", result.errorMessage);
  assert.equal(result.content[0]?.text, "OK");
  assert.deepEqual(records.at(-1).hashes, expected);
  messages.push(result);
}
try {
  for (let n = 0; n < 12; n++) { messages.push({ role: "user", content: [{ type: "text", text: `Frame ${n}` }, image(n)], timestamp: n }); await request(); }
  assert.deepEqual(records.map(r => r.imageCount), Array.from({ length: 12 }, (_, n) => n + 1));
  assert.equal(records[0].chained, false);
  assert.ok(records.slice(1).every(r => r.chained), "Unchanged image history keeps the continuation prefix");
  messages.push({ role: "user", content: "Same image history, another request", timestamp: 14 }); await request();
  assert.equal(records.at(-1).chained, true);
  // A manual serializer checkpoint, not a claim that this invokes Pi compaction.
  messages = [{ role: "user", content: "Compacted action summary", timestamp: 15 }, { role: "user", content: [image(10), image(11), image(0)], timestamp: 16 }];
  await request(); assert.equal(records.at(-1).chained, false, "Compaction must reconstruct instead of retaining old server images");
  await writeFile(path.join(directory, "run.json"), JSON.stringify({ success: true, transport: "native Codex cached WebSocket to local peer", paidCalls: 0,
    records, usage: "synthetic peer usage; not provider billing or cache performance", checks: ["all-twelve-effective-images", "unchanged-prefix-continuation", "same-history-replay", "manual-checkpoint-reconstruction"] }, null, 2));
  console.log(JSON.stringify({ success: true, records: records.length, directory }));
} finally {
  closeOpenAICodexWebSocketSessions(sessionId); for (const socket of peer.clients) socket.terminate();
  await new Promise(resolve => peer.close(resolve));
}
