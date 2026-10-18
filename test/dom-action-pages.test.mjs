import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { createServer, request } from "node:http";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { Script } from "node:vm";
import { createDomActionPages, validateDomActionReport } from "../scripts/fixtures/dom-action-pages.mjs";

const nonce = "22222222-2222-4222-8222-222222222222", pageNonce = "33333333-3333-4333-8333-333333333333";
const counters = () => ({ primary: 0, double: 0, context: 0, hover: 0, press: 0, shadow: 0, duplicateA: 0, duplicateB: 0, async: 0, disabled: 0, hidden: 0 });
const activity = (overrides = {}) => ({ visibilityState: "visible", hasFocus: true, animationFrames: 0, animationOverflow: false, sampledAtMs: 0, ...overrides });
const report = (overrides = {}) => ({ nonce, pageNonce, serial: 1, events: [], eventOverflow: false, counters: counters(),
  state: { value: "initial", checked: false, selected: "first", active: "", asyncStage: "idle", asyncGeneration: 0 }, activity: activity(), ...overrides });
async function fixture(t, options = {}) {
  let pages;
  const server = createServer((req, res) => { void pages.handle(req, res); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  pages = createDomActionPages({ nonce, origin, ...options });
  const post = (value, headers = {}) => new Promise((resolve, reject) => {
    const req = request(`${origin}/dom-action-witness`, { method: "POST", headers: {
      "Content-Type": "application/json", Origin: origin, ...headers } }, res => {
      res.resume(); res.once("end", () => resolve({ status: res.statusCode }));
    });
    req.once("error", reject); req.end(JSON.stringify(value));
  });
  return { origin, pages, post };
}

test("only an exact loopback origin and bounded fixture capacity are accepted", () => {
  const options = { nonce, origin: "http://127.0.0.1:4100" };
  assert.doesNotThrow(() => createDomActionPages(options));
  for (const origin of ["http://example.org:4100", "https://127.0.0.1:4100", "http://user@127.0.0.1:4100", "http://127.0.0.1:4100/path"])
    assert.throws(() => createDomActionPages({ ...options, origin }));
  for (const maxReports of [0, 1201, 1.5]) assert.throws(() => createDomActionPages({ ...options, maxReports }));
});

test("the page loads compilable same-origin code without inline DOM script text", async t => {
  const f = await fixture(t), response = await fetch(f.origin);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const policy = response.headers.get("content-security-policy");
  assert.ok(policy?.split(";").some(directive => directive.trim() === "script-src 'self'"));
  assert.ok(!policy.includes("'unsafe-eval'"));
  const html = await response.text(), scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 1);
  assert.equal(scripts[0][1].trim(), 'src="/fixture.js"');
  assert.equal(scripts[0][2].trim(), "");
  const asset = await fetch(new URL("/fixture.js", f.origin));
  assert.equal(asset.status, 200);
  assert.equal(asset.headers.get("content-type"), "text/javascript; charset=utf-8");
  assert.equal(asset.headers.get("cache-control"), "no-store");
  const script = await asset.text();
  assert.ok(script.length > 1000); assert.doesNotThrow(() => new Script(script));
  assert.equal((await fetch(`${f.origin}/unknown`)).status, 404);
  assert.equal((await fetch(`${f.origin}/fixture.js?foreign`)).status, 404);
  assert.equal((await fetch(`${f.origin}/fixture.js`, { method: "POST" })).status, 404);
  assert.equal((await fetch(f.origin, { method: "POST" })).status, 404);
  const wrongHost = await new Promise((resolve, reject) => {
    const req = request(`${f.origin}/fixture.js`, { headers: { Host: "example.org" } }, res => {
      res.resume(); res.once("end", () => resolve(res.statusCode));
    });
    req.once("error", reject); req.end();
  });
  assert.equal(wrongHost, 400);
});

test("witness validation retains actual state and rejects extra, unknown and oversized data", () => {
  const valid = report({ events: [{ type: "input", trusted: false, target: "value" }],
    state: { ...report().state, value: "DOM value", checked: true, selected: "third" } });
  assert.deepEqual(validateDomActionReport(valid, nonce), valid);
  for (const value of [report({ nonce: pageNonce }), report({ pageNonce: "not-a-document" }), report({ serial: 1201 }),
    report({ events: Array(129).fill({ type: "click", trusted: false, target: "primary" }) }),
    report({ events: [{ type: "click", trusted: false, target: "foreign-target" }] }),
    report({ state: { ...report().state, value: "x".repeat(2001) } }),
    report({ state: { ...report().state, asyncStage: "ready", asyncGeneration: 1 } }),
    report({ counters: { ...counters(), primary: -1 } }), { ...valid, extra: true }])
    assert.throws(() => validateDomActionReport(value, nonce));
});

test("activity facts keep hidden, unfocused and unknown values distinct without claiming paint", () => {
  const hidden = report({ activity: activity({ visibilityState: "hidden", hasFocus: false, animationFrames: 7, sampledAtMs: 1500.25 }) });
  assert.deepEqual(validateDomActionReport(hidden, nonce), hidden);
  const exhausted = report({ activity: activity({ animationFrames: 1000000, animationOverflow: true }) });
  assert.deepEqual(validateDomActionReport(exhausted, nonce), exhausted);
  for (const value of [undefined, null, {}, activity({ visibilityState: "prerender" }), activity({ visibilityState: "unknown" }),
    activity({ hasFocus: "false" }), activity({ animationFrames: -1 }), activity({ animationFrames: 1.5 }),
    activity({ animationFrames: 1000001 }), activity({ animationOverflow: true }), activity({ animationOverflow: "false" }),
    activity({ sampledAtMs: -1 }), activity({ sampledAtMs: 1000001 }), activity({ sampledAtMs: Infinity }),
    activity({ sampledAtMs: NaN }), { ...activity(), paintFresh: true }])
    assert.throws(() => validateDomActionReport(report({ activity: value }), nonce));
});

test("activity reports retain monotonic animation and clock evidence while visibility and focus may change", async t => {
  const f = await fixture(t);
  const first = report({ activity: activity({ animationFrames: 3, sampledAtMs: 20 }) });
  assert.equal((await f.post(first)).status, 204);
  const hidden = report({ serial: 2, activity: activity({ visibilityState: "hidden", hasFocus: false, animationFrames: 3, sampledAtMs: 520 }) });
  assert.equal((await f.post(hidden)).status, 204);
  for (const fields of [{ animationFrames: 2 }, { sampledAtMs: 519 }])
    assert.equal((await f.post({ ...hidden, serial: 3, activity: { ...hidden.activity, ...fields } })).status, 400);
  const resumed = report({ serial: 3, activity: activity({ animationFrames: 4, sampledAtMs: 1020 }) });
  assert.equal((await f.post(resumed)).status, 204);
  const exhausted = report({ serial: 4, activity: activity({ animationFrames: 1000000, animationOverflow: true, sampledAtMs: 2020 }) });
  assert.equal((await f.post(exhausted)).status, 204);
  assert.equal((await f.post({ ...exhausted, serial: 5, activity: { ...exhausted.activity, animationOverflow: false } })).status, 400);
  assert.equal(f.pages.status().rejected, 3);
  assert.deepEqual(f.pages.reports().map(row => row.activity), [first.activity, hidden.activity, resumed.activity, exhausted.activity]);
});

test("the served activity sampler distinguishes running timers from animation callbacks and stops at the deadline", async t => {
  const f = await fixture(t), script = await (await fetch(`${f.origin}/fixture.js`)).text();
  const reports = [], animations = new Map(), deadlines = new Map();
  const flush = () => new Promise(resolve => setImmediate(resolve));
  let now = 100, focused = true, nextAnimation = 0, interval, intervalCleared = false;
  const button = { addEventListener() {} }, shadow = { querySelector: () => button, addEventListener() {} };
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { id, value: id === "selected" ? "first" : "initial", checked: false,
      addEventListener() {}, attachShadow: () => shadow });
    return elements.get(id);
  };
  const document = { visibilityState: "visible", getElementById: element, hasFocus: () => focused, addEventListener() {} };
  new Script(script).runInNewContext({
    document, crypto: { randomUUID: () => pageNonce }, performance: { now: () => now }, queueMicrotask,
    requestAnimationFrame: callback => { animations.set(++nextAnimation, callback); return nextAnimation; },
    cancelAnimationFrame: id => { animations.delete(id); },
    setInterval: callback => { interval = callback; return 1; },
    clearInterval: id => { assert.equal(id, 1); intervalCleared = true; },
    setTimeout: (callback, delay) => { deadlines.set(delay, callback); return delay; },
    fetch: async (_url, options) => { reports.push(JSON.parse(options.body)); return { status: 204 }; },
  });
  await flush();
  assert.deepEqual(reports[0].activity, activity());
  const [animationId, callback] = animations.entries().next().value;
  animations.delete(animationId); now = 112.5; callback(112.5);
  now = 600; document.visibilityState = "hidden"; focused = false; interval(); await flush();
  now = 1100; interval(); await flush();
  assert.deepEqual(reports.slice(-2).map(row => row.activity), [
    activity({ visibilityState: "hidden", hasFocus: false, animationFrames: 1, sampledAtMs: 500 }),
    activity({ visibilityState: "hidden", hasFocus: false, animationFrames: 1, sampledAtMs: 1000 }),
  ]);
  assert.ok(reports.at(-1).serial > reports[0].serial);
  assert.equal(reports.at(-1).state.value, "initial");
  now = 1600; document.visibilityState = "prerender"; interval(); await flush();
  assert.equal(reports.at(-1).activity.visibilityState, "prerender");
  assert.throws(() => validateDomActionReport(reports.at(-1), nonce));
  deadlines.get(600000)();
  assert.equal(intervalCleared, true); assert.equal(animations.size, 0);
  const count = reports.length;
  callback(1700); interval(); await flush();
  assert.equal(reports.length, count); assert.equal(animations.size, 0);
});
test("cross-origin posts, wrong host, bad content type and oversized bodies cannot enter the journal", async t => {
  const f = await fixture(t);
  assert.equal((await f.post(report(), { Origin: "http://127.0.0.1:4200" })).status, 400);
  assert.equal((await f.post(report(), { Origin: "" })).status, 400);
  assert.equal((await f.post(report(), { Host: "example.org" })).status, 400);
  assert.equal((await f.post(report(), { "Content-Type": "text/plain" })).status, 400);
  assert.equal((await f.post({ padding: "x".repeat(25000) })).status, 400);
  assert.equal(f.pages.status().count, 0);
  assert.equal(f.pages.status().rejected, 5);
});

test("split UTF-8 request chunks preserve the page's original field value", async t => {
  const f = await fixture(t), value = "Привет 🌍", body = Buffer.from(JSON.stringify(report({ state: { ...report().state, value } })));
  const split = body.indexOf(Buffer.from("П")) + 1;
  const status = await new Promise((resolve, reject) => {
    const req = request(`${f.origin}/dom-action-witness`, { method: "POST", headers: {
      "Content-Type": "application/json", Origin: f.origin } }, res => { res.resume(); res.once("end", () => resolve(res.statusCode)); });
    req.once("error", reject); req.write(body.subarray(0, split));
    setTimeout(() => req.end(body.subarray(split)), 20);
  });
  assert.equal(status, 204); assert.equal(f.pages.reports()[0].state.value, value);
});

test("a new document, reordered report or erased event prefix cannot hide earlier effects", async t => {
  const f = await fixture(t);
  const event = { type: "click", trusted: false, target: "primary" };
  const first = report({ events: [event], counters: { ...counters(), primary: 1 } });
  assert.equal((await f.post(first)).status, 204);
  const next = { ...first, serial: 2, state: { ...first.state, value: "filled" } };
  assert.equal((await f.post(next)).status, 204);
  for (const value of [{ ...next, serial: 3, pageNonce: "44444444-4444-4444-8444-444444444444" }, next,
    report({ serial: 3 }), { ...next, serial: 3, counters: counters() },
    { ...next, serial: 3, events: [{ ...event, target: "duplicate-a" }] }])
    assert.equal((await f.post(value)).status, 400);
  assert.deepEqual(f.pages.status(), { count: 2, rejected: 5, capacity: 1200, overflow: false });
  const copy = f.pages.reports(); copy[0].events.length = 0;
  assert.equal(f.pages.reports()[0].events.length, 1);
});

test("report capacity and event overflow stay explicit instead of dropping old evidence", async t => {
  const f = await fixture(t, { maxReports: 1 });
  const value = report({ events: Array.from({ length: 128 }, () => ({ type: "click", trusted: false, target: "primary" })), eventOverflow: true });
  assert.equal((await f.post(value)).status, 204);
  assert.equal((await f.post({ ...value, serial: 2 })).status, 400);
  assert.deepEqual(f.pages.status(), { count: 1, rejected: 1, capacity: 1, overflow: true });
  assert.equal(f.pages.reports()[0].eventOverflow, true);
});

test("the HTTP-only helper exits and closes its listener on finish", async t => {
  const child = spawn(process.execPath, ["scripts/dom-action-fixture.mjs", "--live-approved"], { stdio: ["pipe", "pipe", "pipe"] });
  const input = createInterface({ input: child.stdout }); let stderr = "", directory;
  child.stderr.on("data", data => { stderr += data; });
  t.after(async () => { input.close(); if (child.exitCode === null) child.kill(); if (directory) await rm(directory, { recursive: true, force: true }); });
  const exited = new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", (code, signal) => resolve({ code, signal })); });
  const iterator = input[Symbol.asyncIterator]();
  const first = await iterator.next(); assert.equal(first.done, false);
  const ready = JSON.parse(first.value); assert.equal(ready.ready, true); directory = ready.directory;
  assert.equal((await fetch(ready.url)).status, 200);
  child.stdin.end("state\nfinish\n");
  const remaining = []; for await (const line of { [Symbol.asyncIterator]: () => iterator }) remaining.push(JSON.parse(line));
  assert.deepEqual(await exited, { code: 0, signal: null }, stderr);
  assert.equal(remaining.at(-1).server_cleanup, "fulfilled");
  await assert.rejects(fetch(ready.url));
});
