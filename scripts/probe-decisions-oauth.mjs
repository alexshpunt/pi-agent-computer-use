import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// Read existing Pi credentials without refreshing or changing the auth store.
const auth = JSON.parse(await readFile(join(homedir(), ".pi/agent/auth.json"), "utf8"))["openai-codex"];
if (auth?.type !== "oauth" || !auth.access || !auth.accountId) throw new Error("Existing Codex OAuth credentials are required.");
const claims = JSON.parse(Buffer.from(auth.access.split(".")[1], "base64url").toString("utf8"));
if (!Number.isFinite(claims.exp) || claims.exp * 1000 <= Date.now()) throw new Error("Access token is expired; this probe never refreshes credentials.");
const secrets = [auth.access, auth.refresh, auth.accountId, claims.sub, claims.jti].filter(value => typeof value === "string" && value.length > 0);
const redact = value => secrets.reduce((text, secret) => text.split(secret).join("[redacted]"), String(value));
const decision = {
  model: "gpt-6-luna", input: "The package arrived with a broken screen.",
  questions: [{ type: "choice", name: "condition", instructions: "What condition does the customer report?",
    choices: [{ value: "damaged", description: "A broken or damaged item." },
      { value: "intact", description: "An undamaged item." }, { value: "other", description: "Not enough information." }] }],
};
const responses = model => ({ model, instructions: "Reply briefly.",
  input: [{ role: "user", content: [{ type: "input_text", text: "Say exactly: OK" }] }], store: false, stream: true });
const cases = {
  "public-models": { url: "https://api.openai.com/v1/models", method: "GET" },
  "public-responses": { url: "https://api.openai.com/v1/responses", body: responses("gpt-6.1-sol") },
  "public-decisions": { url: "https://api.openai.com/v1/decisions", body: decision },
  "public-decisions-account": { url: "https://api.openai.com/v1/decisions", body: decision, codexHeaders: true },
  // This sibling route is a hypothesis, not a documented Codex API.
  "codex-decisions": { url: "https://chatgpt.com/backend-api/codex/decisions", body: decision, codexHeaders: true },
  "codex-luna-responses": { url: "https://chatgpt.com/backend-api/codex/responses", body: responses("gpt-6-luna"), codexHeaders: true },
  "codex-control": { url: "https://chatgpt.com/backend-api/codex/responses", body: responses("gpt-6.1-sol"), codexHeaders: true },
  "codex-luna-questions": { url: "https://chatgpt.com/backend-api/codex/responses", codexHeaders: true,
    body: { ...responses("gpt-6-luna"), input: [{ role: "user", content: decision.input }], questions: decision.questions } },
  "codex-luna-schema": { url: "https://chatgpt.com/backend-api/codex/responses", codexHeaders: true,
    body: { ...responses("gpt-6-luna"), instructions: "Classify the reported package condition as damaged, intact or other.",
      input: [{ role: "user", content: decision.input }],
      text: { format: { type: "json_schema", name: "condition", strict: true,
        schema: { type: "object", properties: { choice: { type: "string", enum: ["damaged", "intact", "other"] } },
          required: ["choice"], additionalProperties: false } } } } },
};
const selected = process.argv.slice(2);
if (!selected.length || selected.some(name => !Object.hasOwn(cases, name))) throw new Error(`Choose probe cases: ${Object.keys(cases).join(", ")}`);
console.log(JSON.stringify({ time: new Date().toISOString(), token: { audience: claims.aud, scopes: claims.scope ?? claims.scp ?? null,
  expires: new Date(claims.exp * 1000).toISOString(), claimsVerified: false }, noRefresh: true, noRetries: true }));
for (const name of selected) {
  const probe = cases[name];
  const headers = { Authorization: `Bearer ${auth.access}`, "Content-Type": "application/json" };
  if (probe.codexHeaders) Object.assign(headers, { "chatgpt-account-id": auth.accountId, "OpenAI-Beta": "responses=experimental", originator: "pi" });
  const started = performance.now();
  try {
    const response = await fetch(probe.url, { method: probe.method ?? "POST", headers,
      ...(probe.body ? { body: JSON.stringify(probe.body) } : {}), signal: AbortSignal.timeout(30000), redirect: "error" });
    const body = await response.text();
    const report = { name, url: probe.url, status: response.status, elapsedMs: Math.round(performance.now() - started),
      contentType: response.headers.get("content-type"), requestId: response.headers.get("x-request-id"),
      cfRay: response.headers.get("cf-ray"), server: response.headers.get("server") };
    if (response.headers.get("content-type")?.includes("text/event-stream") || body.startsWith("event: ")) {
      const events = body.split("\n").filter(line => line.startsWith("data: ")).flatMap(line => {
        try { return [JSON.parse(line.slice(6))]; } catch { return []; }
      });
      report.events = [...new Set(events.map(event => event.type))];
      report.text = events.filter(event => event.type === "response.output_text.delta").map(event => event.delta).join("");
      const terminal = events.findLast(event => ["response.completed", "response.failed", "response.incomplete", "error"].includes(event.type));
      report.terminal = terminal ? { type: terminal.type, status: terminal.response?.status, model: terminal.response?.model,
        error: terminal.error ?? terminal.response?.error, usage: terminal.response?.usage && {
          inputTokens: terminal.response.usage.input_tokens, outputTokens: terminal.response.usage.output_tokens,
          totalTokens: terminal.response.usage.total_tokens } } : null;
    } else if (response.ok && probe.method === "GET") {
      const data = JSON.parse(body);
      report.models = (data.models ?? data.data ?? []).map(model => ({ id: model.slug ?? model.id, visibility: model.visibility }));
    } else if (response.headers.get("content-type")?.includes("text/html")) {
      report.bodyKind = "html";
      report.cloudflareChallenge = body.includes("Enable JavaScript and cookies to continue") || body.includes("_cf_chl_opt");
    } else {
      report.body = body.slice(0, 6000);
      report.bodyTruncated = body.length > 6000;
    }
    console.log(redact(JSON.stringify(report)));
  } catch (error) {
    console.log(redact(JSON.stringify({ name, url: probe.url, elapsedMs: Math.round(performance.now() - started), error: error.message })));
  }
}
