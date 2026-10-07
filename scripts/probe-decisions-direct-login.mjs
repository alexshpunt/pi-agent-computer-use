import { createHash, createPublicKey, randomBytes, randomUUID, verify } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// One-user research login. Never reads or changes Pi credentials. Tokens stay in memory.
const storage = join(homedir(), ".config/pi-agent-computer-use-decisions-probe");
await mkdir(storage, { recursive: true, mode: 0o700 });
const registrationPath = join(storage, "registration.json");
let registration;
try { registration = JSON.parse(await readFile(registrationPath, "utf8")); }
catch (error) {
  if (error.code !== "ENOENT") throw error;
  registration = { hostId: `urn:uuid:${randomUUID()}` };
  await writeFile(registrationPath, JSON.stringify(registration), { mode: 0o600, flag: "wx" });
}
const redirectUri = "http://127.0.0.1:1457/auth/callback";
const resource = "https://api.openai.com/v1";
const state = randomBytes(32).toString("base64url");
const nonce = randomBytes(32).toString("base64url");
const verifier = randomBytes(64).toString("base64url");
const expires = Date.now() + 10 * 60 * 1000;
const authorization = new URL("https://auth.openai.com/api/accounts/authorize");
authorization.search = new URLSearchParams({ client_id: registration.clientId ?? "dynamic_agent_client",
  ...(registration.clientId ? {} : { agent_name_hint: "Pi Agent Computer Use Decisions Probe" }),
  ext_agent_host_id: registration.hostId, response_type: "code", redirect_uri: redirectUri,
  scope: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct", resource,
  state, nonce, code_challenge_method: "S256", code_challenge: createHash("sha256").update(verifier).digest("base64url") }).toString();
const secrets = [state, nonce, verifier];
const redact = text => secrets.reduce((value, secret) => value.split(secret).join("[redacted]"), String(text));
const log = value => console.log(redact(JSON.stringify(value)));
let consumed = false;

async function request(url, init = {}) {
  return fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(30000) });
}

// Only the RS256 algorithm advertised by OpenAI discovery is accepted.
async function verifyIdentity(token, clientId) {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Invalid ID-token shape.");
  const header = JSON.parse(Buffer.from(parts[0], "base64url").toString());
  if (header.alg !== "RS256" || typeof header.kid !== "string") throw new Error("Unsupported ID-token signing header.");
  const response = await request("https://auth.openai.com/.well-known/jwks.json");
  if (!response.ok) throw new Error(`JWKS returned ${response.status}.`);
  const jwk = (await response.json()).keys.find(key => key.kid === header.kid && key.kty === "RSA" && (!key.alg || key.alg === "RS256"));
  if (!jwk || !verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key: jwk, format: "jwk" }), Buffer.from(parts[2], "base64url")))
    throw new Error("ID-token signature verification failed.");
  const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString());
  const now = Date.now() / 1000;
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== "https://auth.openai.com" || !audiences.includes(clientId) || claims.nonce !== nonce ||
      typeof claims.sub !== "string" || !claims.sub || !Number.isFinite(claims.exp) || claims.exp <= now - 5 ||
      !Number.isFinite(claims.iat) || claims.iat > now + 5 || (claims.nbf !== undefined && claims.nbf > now + 5))
    throw new Error("ID-token identity claims did not validate.");
  secrets.push(claims.sub, ...(claims.email ? [claims.email] : []));
}

async function probe(accessToken) {
  const headers = { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" };
  const catalogResponse = await request(`${resource}/models`, { headers });
  const catalogText = await catalogResponse.text();
  log({ name: "direct-models", status: catalogResponse.status, requestId: catalogResponse.headers.get("x-request-id"),
    ...(!catalogResponse.ok ? { body: catalogText.slice(0, 4000) } : {}) });
  let controlModel;
  if (catalogResponse.ok) {
    const catalog = JSON.parse(catalogText);
    const models = catalog.models ?? [];
    log({ name: "direct-model-slugs", models: models.map(model => ({ slug: model.slug, visibility: model.visibility })) });
    controlModel = models.find(model => model.slug === "gpt-6.1-sol")?.slug ?? models.find(model => model.visibility === "list")?.slug;
  }
  const cases = [
    ...(controlModel ? [{ name: "direct-responses-control", url: `${resource}/responses`, body: {
      model: controlModel, instructions: "Reply briefly.", input: [{ role: "user", content: "Say exactly: OK" }], store: false, stream: true } }] : []),
    { name: "direct-decisions", url: `${resource}/decisions`, body: { model: "gpt-6-luna",
      input: "The package arrived with a broken screen.", questions: [{ type: "choice", name: "condition",
        instructions: "What condition does the customer report?", choices: [
          { value: "damaged", description: "A broken or damaged item." }, { value: "intact", description: "An undamaged item." },
          { value: "other", description: "Not enough information." }] }] } },
  ];
  for (const test of cases) {
    const start = performance.now();
    const response = await request(test.url, { method: "POST", headers, body: JSON.stringify(test.body) });
    const text = await response.text();
    const report = { name: test.name, url: test.url, status: response.status, elapsedMs: Math.round(performance.now() - start),
      requestId: response.headers.get("x-request-id"), contentType: response.headers.get("content-type") };
    if (text.startsWith("event: ") || response.headers.get("content-type")?.includes("text/event-stream")) {
      const events = text.split("\n").filter(line => line.startsWith("data: ")).flatMap(line => {
        try { return [JSON.parse(line.slice(6))]; } catch { return []; }
      });
      report.text = events.filter(event => event.type === "response.output_text.delta").map(event => event.delta).join("");
      const terminal = events.findLast(event => ["response.completed", "response.failed", "response.incomplete", "error"].includes(event.type));
      report.terminal = terminal ? { type: terminal.type, model: terminal.response?.model,
        error: terminal.error ?? terminal.response?.error } : null;
    } else report.body = text.slice(0, 4000);
    log(report);
  }
}

const server = createServer(async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  const url = new URL(req.url, "http://127.0.0.1:1457");
  if (req.method !== "GET") { res.writeHead(405).end(); return; }
  if (url.pathname === "/") {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end('<h1>Pi Agent Computer Use Decisions Probe</h1><p>Separate research login. Your Pi login will not change. Tokens stay in memory. Host and client registration are saved separately under ~/.config/pi-agent-computer-use-decisions-probe.</p><p><a href="/login">Continue with ChatGPT</a></p>');
    return;
  }
  if (url.pathname === "/login" && !consumed && Date.now() < expires) {
    res.writeHead(302, { Location: authorization.toString() }).end(); return;
  }
  if (url.pathname !== "/auth/callback") { res.writeHead(404).end(); return; }
  if (consumed || Date.now() >= expires || url.searchParams.get("state") !== state) { res.writeHead(400).end("Invalid or expired callback state."); return; }
  consumed = true;
  try {
    if (url.searchParams.has("error")) throw new Error(`Authorization refused: ${url.searchParams.get("error")}`);
    const code = url.searchParams.get("code");
    const clientId = url.searchParams.get("client_id") ?? registration.clientId;
    if (!code || !clientId || clientId === "dynamic_agent_client" || (registration.clientId && clientId !== registration.clientId))
      throw new Error("Callback did not contain the expected issued client ID and code.");
    secrets.push(code, clientId);
    registration.clientId = clientId;
    await writeFile(registrationPath, JSON.stringify(registration), { mode: 0o600 });
    const response = await request("https://auth.openai.com/api/accounts/oauth/token", { method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", client_id: clientId, code,
        code_verifier: verifier, redirect_uri: redirectUri, resource }) });
    if (!response.ok) {
      log({ phase: "token-exchange", status: response.status, requestId: response.headers.get("x-request-id") });
      throw new Error("Token exchange was refused. No retry was made.");
    }
    const tokens = await response.json();
    for (const key of ["access_token", "refresh_token", "id_token"]) if (typeof tokens[key] === "string") secrets.push(tokens[key]);
    if (typeof tokens.id_token !== "string") throw new Error("No ID token was issued.");
    await verifyIdentity(tokens.id_token, clientId);
    const scopes = typeof tokens.scope === "string" ? tokens.scope.split(/\s+/) : [];
    log({ phase: "login", identityVerified: true, scopes, directSharing: scopes.includes("chatgpt.tokens.use.direct") });
    if (!scopes.includes("chatgpt.tokens.use.direct") || typeof tokens.access_token !== "string") throw new Error("Direct-sharing permission was not granted; inference stopped.");
    res.end("Sign-in verified. Return to Pi for the probe results. No tokens were saved.");
    await probe(tokens.access_token);
  } catch (error) {
    log({ phase: "login-or-probe", error: error.message });
    if (!res.writableEnded) res.writeHead(400).end("Sign-in or probe failed. Return to Pi for the diagnostic. No tokens were saved.");
  } finally { clearTimeout(expiryTimer); server.close(); }
});
const expiryTimer = setTimeout(() => { log({ phase: "login", error: "Authorization attempt expired after 10 minutes." }); server.close(); }, 10 * 60 * 1000);
server.on("error", error => { clearTimeout(expiryTimer); log({ phase: "listener", error: error.message }); process.exitCode = 1; });
server.listen(1457, "127.0.0.1", () => log({ phase: "waiting-for-user", open: "http://127.0.0.1:1457", timeoutMinutes: 10, tokensSaved: false }));
