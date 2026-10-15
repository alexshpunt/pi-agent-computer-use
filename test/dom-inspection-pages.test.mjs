import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { createDomInspectionPages, validateDomInspectionReport } from "../scripts/fixtures/dom-inspection-pages.mjs";

const nonce = "22222222-2222-4222-8222-222222222222";
const pageNonce = "33333333-3333-4333-8333-333333333333";
const report = (overrides = {}) => ({ nonce, page: "root", pageNonce, serial: 1, stage: 0,
  events: [], eventOverflow: false, detached: false, geometrySpace: "css_viewport_pixels",
  viewport: { width: 888, height: 554, device_pixel_ratio: 1.5, scroll_x: 0, scroll_y: 200 }, nodes: [], ...overrides });
async function fixture(t, options = {}) {
  let pages;
  const servers = [createServer((req, res) => pages.handle(req, res)), createServer((req, res) => pages.handle(req, res))];
  for (const server of servers) await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { for (const server of servers) await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }); });
  const [origin, crossOrigin] = servers.map(server => `http://127.0.0.1:${server.address().port}`);
  pages = createDomInspectionPages({ nonce, origin, crossOrigin, ...options });
  const post = (value, target = origin) => fetch(`${target}/dom-witness`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) });
  return { origin, crossOrigin, pages, post };
}

test("only explicit distinct loopback origins can be used for fixture frames", () => {
  const options = { nonce, origin: "http://127.0.0.1:4100", crossOrigin: "http://127.0.0.1:4200" };
  assert.doesNotThrow(() => createDomInspectionPages(options));
  for (const crossOrigin of [options.origin, "https://127.0.0.1:4200", "http://example.org:4200", "http://user:pass@127.0.0.1:4200", "http://127.0.0.1:4200/path"])
    assert.throws(() => createDomInspectionPages({ ...options, crossOrigin }));
  assert.throws(() => createDomInspectionPages({ ...options, transitionAfterMs: 240001 }));
});

test("document routes remain on their intended origin without a broader fallback", async t => {
  const f = await fixture(t);
  for (const path of ["/", "/frame", "/nested"]) {
    const response = await fetch(`${f.origin}${path}`);
    assert.equal(response.status, 200); assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8");
    assert.equal((await fetch(`${f.crossOrigin}${path}`)).status, 404);
  }
  assert.equal((await fetch(`${f.crossOrigin}/cross`)).status, 200);
  assert.equal((await fetch(`${f.origin}/cross`)).status, 404);
  assert.equal((await fetch(`${f.origin}/unexpected`)).status, 404);
});

test("report validation preserves CSS geometry and rejects invented or unbounded witness data", () => {
  const valid = report({ nodes: [{ id: "value", connected: true, hidden: false, disabled: false, checked: false, selected: false,
    value: "fixture value", attributes: { "data-testid": "value", "aria-label": null, "data-generation": null, title: "Field attribute" }, bounds: { x: 2, y: 3, width: 80, height: 20 } }] });
  assert.deepEqual(validateDomInspectionReport(valid, nonce), valid);
  for (const changed of [report({ nonce: pageNonce }), report({ geometrySpace: "windows_desktop_pixels" }), report({ serial: 513 }),
    report({ stage: 1, detached: false }), report({ events: Array(33).fill({ type: "click", trusted: false, target: "transition" }) }),
    { ...valid, nodes: [...valid.nodes, ...valid.nodes] }, { ...valid, extra: true }]) assert.throws(() => validateDomInspectionReport(changed, nonce));
});

test("viewport CSS and page scale remain independent witness values, not native pixels", () => {
  const valid = report();
  assert.deepEqual(validateDomInspectionReport(valid, nonce).viewport, valid.viewport);
  for (const viewport of [null, { ...valid.viewport, width: 0 }, { ...valid.viewport, device_pixel_ratio: -1 },
    { ...valid.viewport, scroll_y: Infinity }, { ...valid.viewport, native_x: 1 }])
    assert.throws(() => validateDomInspectionReport(report({ viewport }), nonce));
});
test("capacity is enforced before insertion and returned report copies cannot mutate evidence", async t => {
  const f = await fixture(t, { maxReports: 1 });
  assert.equal((await f.post(report())).status, 204);
  assert.equal((await f.post(report({ serial: 2 }))).status, 400);
  assert.deepEqual(f.pages.status(), { count: 1, rejected: 1, capacity: 1 });
  const copy = f.pages.reports(); copy[0].nonce = "changed"; copy.push(report());
  assert.equal(f.pages.reports().length, 1); assert.equal(f.pages.reports()[0].nonce, nonce);
});

test("same-page progression is admitted while replacement, reordering and foreign-origin reports refuse", async t => {
  const f = await fixture(t);
  assert.equal((await f.post(report())).status, 204);
  assert.equal((await f.post(report({ serial: 2, stage: 1, detached: true }))).status, 204);
  assert.equal((await f.post(report({ serial: 3, pageNonce: "44444444-4444-4444-8444-444444444444" }))).status, 400);
  assert.equal((await f.post(report({ serial: 2, stage: 1, detached: true }))).status, 400);
  assert.equal((await f.post(report({ serial: 3 }))).status, 400);
  assert.equal((await f.post(report({ page: "cross" }))).status, 400);
  assert.equal((await f.post(report({ page: "cross" }), f.crossOrigin)).status, 204);
  assert.deepEqual(f.pages.status(), { count: 3, rejected: 4, capacity: 2048 });
});
