#!/usr/bin/env node
/** Inspect Pi's real Responses serializers against loopback only. No account, prewarm or billed model call. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { zstdDecompressSync } from "node:zlib";
import path from "node:path";
// An optional package root lets the same probe qualify the active Pi installation, not only dev dependencies.
const packageFile = process.argv[2] ? pathToFileURL(path.resolve(process.argv[2], "package.json"))
  : new URL("../package.json", import.meta.resolve("@earendil-works/pi-ai"));
const packageInfo = JSON.parse(await readFile(packageFile, "utf8"));
assert.equal(packageInfo.name, "@earendil-works/pi-ai");
const moduleUrl = name => new URL(`dist/api/${name}.js`, packageFile);
const { stream: responses } = await import(moduleUrl("openai-responses").href);
const { stream: codex } = await import(moduleUrl("openai-codex-responses").href);

const directory = path.resolve(".tmp/cache-controls"); await mkdir(directory, { recursive: true });
const wire = [];
const peer = createServer(async (request, response) => {
  const chunks = []; for await (const chunk of request) chunks.push(chunk);
  const encoded = Buffer.concat(chunks); assert.ok(encoded.length < 1024 * 1024);
  const encoding = request.headers["content-encoding"] ?? "identity";
  assert.ok(["identity", "zstd"].includes(encoding));
  const decoded = encoding === "zstd" ? zstdDecompressSync(encoded, { maxOutputLength: 1024 * 1024 }) : encoded;
  const body = JSON.parse(decoded.toString("utf8")); wire.push({ body, encoding });
  const id = `resp-${wire.length}`;
  const item = { id: `msg-${wire.length}`, type: "message", role: "assistant", status: "completed",
    content: [{ type: "output_text", text: "OK", annotations: [] }] };
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const event of [
    { type: "response.created", response: { id, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
    { type: "response.content_part.added", output_index: 0, item_id: item.id, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
    { type: "response.output_text.delta", output_index: 0, item_id: item.id, content_index: 0, delta: "OK" },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id, status: "completed", output: [item],
      usage: { input_tokens: 200, output_tokens: 1, total_tokens: 201,
        input_tokens_details: { cached_tokens: 40, cache_write_tokens: 20 }, output_tokens_details: { reasoning_tokens: 0 } } } },
  ]) response.write(`data: ${JSON.stringify(event)}\n\n`);
  response.end("data: [DONE]\n\n");
});
await new Promise(resolve => peer.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${peer.address().port}`;
const token = `test.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "loopback-only" } })).toString("base64url")}.test`;
const data = (await readFile(new URL("../test/fixtures/cua-zoom.jpg", import.meta.url))).toString("base64");
const context = { systemPrompt: "Stable synthetic prefix. Never execute tools.", messages: [{ role: "user",
  content: [{ type: "text", text: "Check one synthetic image." }, { type: "image", data, mimeType: "image/jpeg" }], timestamp: 0 }] };
const cases = [
  { route: "public-responses-legacy-cache", stream: responses, provider: "openai", api: "openai-responses", explicit: false },
  { route: "public-responses-explicit-cache", stream: responses, provider: "openai", api: "openai-responses", explicit: true },
  { route: "codex-oauth-sse", stream: codex, provider: "openai-codex", api: "openai-codex-responses", explicit: true },
];
const records = [];
try {
  for (const route of cases) for (const retention of ["none", "short", "long"]) {
    const model = { id: "fixture", name: "Loopback cache controls", provider: route.provider, api: route.api,
      baseUrl: origin + (route.provider === "openai-codex" ? "/backend-api" : "/v1"),
      input: ["text", "image"], reasoning: false, contextWindow: 128000, maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compat: { supportsExplicitPromptCacheMode: route.explicit, supportsLongCacheRetention: true } };
    const result = await route.stream(model, context, { apiKey: route.provider === "openai-codex" ? token : "loopback-only",
      transport: "sse", sessionId: "cache-control-probe", cacheRetention: retention, timeoutMs: 3000,
      env: { PI_CACHE_RETENTION: "short" } }).result();
    assert.equal(result.stopReason, "stop", result.errorMessage);
    assert.equal(result.content[0]?.text, "OK");
    assert.equal(result.usage.input, 140); assert.equal(result.usage.cacheRead, 40); assert.equal(result.usage.cacheWrite, 20);
    const { body, encoding } = wire.at(-1);
    const images = [...JSON.stringify(body).matchAll(/data:image\/jpeg;base64,([A-Za-z0-9+/=]+)/g)];
    assert.equal(images.length, 1); assert.equal(images[0][1], data);
    assert.equal(body.prompt_cache_key, retention === "none" ? undefined : "cache-control-probe");
    const expected = route.route === "public-responses-explicit-cache"
      ? retention === "none" ? { mode: "explicit" } : retention === "long" ? { ttl: "30m" } : undefined
      : undefined;
    assert.deepEqual(body.prompt_cache_options, expected);
    assert.equal(body.prompt_cache_retention, route.route === "public-responses-legacy-cache" && retention === "long" ? "24h" : undefined);
    assert.ok(!JSON.stringify(body).includes("prewarm"));
    records.push({ route: route.route, retention, encoding, promptCacheKeyPresent: !!body.prompt_cache_key,
      promptCacheOptions: body.prompt_cache_options ?? null, promptCacheRetention: body.prompt_cache_retention ?? null,
      images: 1, imageHash: createHash("sha256").update(Buffer.from(data, "base64")).digest("hex"),
      usage: { input: result.usage.input, output: result.usage.output, cacheRead: result.usage.cacheRead, cacheWrite: result.usage.cacheWrite },
      usageSource: "synthetic loopback response; parser contract only" });
  }
  const source = {};
  for (const name of ["openai-responses", "openai-codex-responses"]) {
    const file = fileURLToPath(moduleUrl(name));
    source[name] = { hash: createHash("sha256").update(await readFile(file)).digest("hex") };
  }
  const version = packageInfo.version;
  const report = { success: true, piAiVersion: version, source, records, paidCalls: 0, remoteProviderCalls: 0,
    limits: ["Serializer output is not remote support or cache reuse.", "Usage is synthetic, not measured billing or TTFT.",
      "Codex short/long only retain session affinity here; none is not proof of server-side caching disabled.",
      "Public model compatibility flags are controlled fixture inputs, not qualification of a remote model.",
      "No payload override, account credentials, prewarm, model runtime or machine setting was used."] };
  await writeFile(path.join(directory, "run.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ success: true, piAiVersion: version, requests: records.length, paidCalls: 0, remoteProviderCalls: 0, directory }));
} finally {
  peer.closeAllConnections(); await new Promise((resolve, reject) => peer.close(error => error ? reject(error) : resolve()));
}
