import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, request } from "node:http";
import test from "node:test";
import { createDomNativeDetailFixture } from "../scripts/dom-native-detail-fixture.mjs";
import { VIEWPORT_MARKERS } from "../scripts/fixtures/dom-viewport-proof-page.mjs";
import { closePixelProbeServer } from "../scripts/dom-native-pixel-contract.mjs";

const report = (nonce, origin, documentId, serial = 1, stage = 0, events = []) => ({
  nonce, documentId, serial, stage, events, overflow: false, location: `${origin}/`,
  viewport: { width: 886, height: 546, dpr: 1.5, scrollX: 0, scrollY: stage * 100,
    visual: { offset_x: 0, offset_y: 0, page_x: 0, page_y: stage * 100, width: 886, height: 546, scale: 1 } },
  markers: VIEWPORT_MARKERS.map(marker => ({ id: marker.id, bounds: { x: marker.x, y: marker.y - stage * 100, width: marker.width, height: marker.height } })),
});
async function run(check) {
  let fixture;
  const server = createServer((req, res) => void fixture.handle(req, res));
  await new Promise(done => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${server.address().port}`, nonce = randomUUID(), documentId = randomUUID();
  fixture = createDomNativeDetailFixture(nonce, origin);
  const send = (value, headers = {}, path = "/witness", method = "POST") => new Promise((done, reject) => {
    const body = value === undefined ? "" : JSON.stringify(value), chunks = [];
    const req = request(`${origin}${path}`, { method, headers: { Origin: origin, "Content-Type": "application/json", ...headers } }, res => {
      res.on("data", chunk => chunks.push(chunk)); res.on("end", () => done({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.setTimeout(2000, () => req.destroy(Error("Fixture request deadline"))); req.on("error", reject); req.end(body);
  });
  try { await check({ fixture, origin, nonce, documentId, send, value: (serial, stage, events) => report(nonce, origin, documentId, serial, stage, events) }); }
  finally { await closePixelProbeServer(server); }
}

test("the real loopback fixture preserves the sealed setup prefix across both fixed scroll stages", () => run(async ({ fixture, send, value }) => {
  const events = [{ type: "pointerover", trusted: true }];
  assert.equal((await send(value(1, 0, events))).status, 204);
  const baseline = fixture.seal(); assert.deepEqual(baseline.events, events);
  assert.equal((await send(value(2, 1, events))).status, 204);
  assert.equal(fixture.status().baseline_serial, 1); assert.equal(fixture.status().count, 2);
  const external = fixture.reports(); external[0].events.length = 0;
  assert.deepEqual(fixture.reports()[0].events, events);
  assert.equal((await send(value(3, 1, [...events, { type: "click", trusted: false }]))).status, 400);
  assert.equal(fixture.status().count, 2); assert.equal(fixture.status().rejected, 1);
}));

test("unknown document, reordered serial, erased prefix and changed geometry never enter the witness", () => run(async ({ fixture, send, value }) => {
  const events = [{ type: "focus", trusted: true }];
  assert.equal((await send(value(1, 0, events))).status, 204);
  for (const change of [
    v => v.documentId = randomUUID(), v => v.serial = 3, v => v.events = [],
    v => v.markers[0].bounds.x++, v => v.viewport.dpr = 1, v => v.private = "unaccepted", v => v.overflow = true,
  ]) { const next = value(2, 0, events); change(next); assert.equal((await send(next)).status, 400); }
  assert.equal(fixture.status().count, 1); assert.equal(fixture.status().rejected, 7);
}));

test("foreign hosts, missing or foreign POST origins and unknown routes refuse without reports", () => run(async ({ fixture, send, value }) => {
  assert.equal((await send(value(1), { Host: "example.invalid" })).status, 400);
  assert.equal((await send(value(1), { Origin: "http://example.invalid" })).status, 400);
  assert.equal((await send(value(1), { Origin: "" })).status, 400);
  assert.equal((await send(value(1), {}, "/unknown")).status, 400);
  assert.equal(fixture.status().count, 0); assert.equal(fixture.status().rejected, 4);
  assert.throws(() => fixture.seal());
}));

test("HTML and fixed external JS are served independently with no-store and same-origin script policy", () => run(async ({ send }) => {
  const html = await send(undefined, {}, "/", "GET"), script = await send(undefined, {}, "/fixture.js", "GET");
  assert.equal(html.status, 200); assert.equal(script.status, 200);
  assert.match(html.headers["content-security-policy"], /script-src 'self'/);
  assert.equal(html.headers["cache-control"], "no-store"); assert.match(script.headers["content-type"], /^text\/javascript/);
  assert.match(html.body, /<script src="\/fixture.js"><\/script>/); assert.doesNotMatch(html.body, /<script>/);
  assert.equal((await send(undefined, {}, "/favicon.ico", "GET")).status, 204);
}));

test("the fixture refuses a non-loopback or noncanonical origin before creating a listener", () => {
  const nonce = randomUUID();
  for (const origin of ["https://127.0.0.1:9999", "http://localhost:9999", "http://example.invalid:9999", "http://127.0.0.1:9999/", "http://127.0.0.1:9999/path"])
    assert.throws(() => createDomNativeDetailFixture(nonce, origin));
});

test("capacity exhaustion is explicit and cannot grow retained evidence", async () => {
  const { Readable } = await import("node:stream");
  const nonce = randomUUID(), documentId = randomUUID(), origin = "http://127.0.0.1:9999";
  const fixture = createDomNativeDetailFixture(nonce, origin);
  for (let serial = 1; serial <= 501; serial++) {
    const req = Readable.from([Buffer.from(JSON.stringify(report(nonce, origin, documentId, serial)))]);
    Object.assign(req, { headers: { host: "127.0.0.1:9999", origin, "content-type": "application/json" }, method: "POST", url: "/witness" });
    const res = { status: 0, headersSent: false, writeHead(status) { this.status = status; this.headersSent = true; return this; }, end() {} };
    await fixture.handle(req, res);
    assert.equal(res.status, serial <= 500 ? 204 : 400);
  }
  assert.deepEqual(fixture.status(), { count: 500, rejected: 1, capacity: 500, overflow: true, baseline_serial: null });
});

test("the approved HTTP-only CLI starts, saves empty evidence and closes on finish", async () => {
  const root = path.resolve(import.meta.dirname, "../.tmp"); await mkdir(root, { recursive: true });
  const cwd = await mkdtemp(path.join(root, "native-detail-cli-"));
  const child = spawn(process.execPath, [fileURLToPath(new URL("../scripts/dom-native-detail-fixture.mjs", import.meta.url)), "--live-approved"],
    { cwd, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "", sent = false;
  child.stdout.on("data", chunk => {
    stdout += chunk.toString();
    if (!sent && stdout.includes('"ready":true')) { sent = true; child.stdin.end("finish\n"); }
  });
  child.stderr.on("data", chunk => { stderr += chunk.toString(); });
  const deadline = setTimeout(() => child.kill("SIGTERM"), 5000);
  try {
    const code = await new Promise((done, reject) => { child.once("error", reject); child.once("close", done); });
    assert.equal(code, 0, stderr); assert.equal(sent, true);
    const rows = stdout.trim().split("\n").map(line => JSON.parse(line));
    assert.equal(rows[0].ready, true); assert.equal(rows.at(-1).server_cleanup, "confirmed");
    const saved = JSON.parse(await readFile(path.join(cwd, rows[0].directory, "run.json"), "utf8"));
    assert.equal(saved.status.count, 0); assert.equal(saved.status.rejected, 0); assert.deepEqual(saved.reports, []);
  } finally { clearTimeout(deadline); if (child.exitCode === null) child.kill("SIGTERM"); await rm(cwd, { recursive: true, force: true }); }
});

for (const [label, earlyInput] of [["EOF", ""], ["pre-sent finish", "finish\n"]]) test(`CLI preserves ${label} while listen is pending`, async () => {
  const root = path.resolve(import.meta.dirname, "../.tmp"); await mkdir(root, { recursive: true });
  const cwd = await mkdtemp(path.join(root, "native-detail-early-")), preload = path.join(cwd, "delay-listen.cjs");
  // Test-only scheduling: hold the real listen callback until stdin has ended.
  await writeFile(preload, `const {Server}=require('node:http');const listen=Server.prototype.listen;
Server.prototype.listen=function(...args){const callback=args.pop();return listen.call(this,...args,function(...values){
const done=()=>setTimeout(()=>callback.apply(this,values),25);if(process.stdin.readableEnded)done();else process.stdin.once('end',done);
});};`);
  const child = spawn(process.execPath, ["--require", preload, fileURLToPath(new URL("../scripts/dom-native-detail-fixture.mjs", import.meta.url)), "--live-approved"],
    { cwd, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk.toString(); }); child.stderr.on("data", chunk => { stderr += chunk.toString(); });
  child.stdin.end(earlyInput);
  // Only this owned synthetic child is killed if its cleanup hangs; no GUI exists.
  const deadline = setTimeout(() => child.kill("SIGKILL"), 1500);
  try {
    const outcome = await new Promise((done, reject) => { child.once("error", reject); child.once("close", (code, signal) => done({ code, signal })); });
    assert.deepEqual(outcome, { code: 0, signal: null }, stderr);
    const rows = stdout.trim().split("\n").map(line => JSON.parse(line));
    assert.equal(rows[0].ready, true); assert.equal(rows.at(-1).server_cleanup, "confirmed");
    const saved = JSON.parse(await readFile(path.join(cwd, rows[0].directory, "run.json"), "utf8"));
    assert.equal(saved.status.count, 0); assert.equal(saved.status.rejected, 0);
  } finally { clearTimeout(deadline); if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await rm(cwd, { recursive: true, force: true }); }
});