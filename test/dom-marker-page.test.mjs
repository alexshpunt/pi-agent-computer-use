import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { createDomPixelPage } from "../scripts/fixtures/dom-marker-page.mjs";
import { MARKERS } from "../scripts/dom-marker-geometry.mjs";
import { assertReadonlyPixelWitness } from "../scripts/dom-native-pixel-contract.mjs";

const nonce = "83bfcb97-f996-4706-977c-1158dbbbd0cf", title = `Pi DOM pixel proof ${nonce.slice(0, 8)}`;
function page(cssomMarkers, missing = false) {
  const html = createDomPixelPage({ title, nonce, cssomMarkers });
  const source = html.match(/<script>([\s\S]*)<\/script>/)?.[1]; assert.ok(source);
  const reports = [], listeners = new Map(); let interval;
  const context = {
    crypto: { randomUUID: () => "owned-document-1" },
    document: { addEventListener: (type, callback) => listeners.set(type, callback),
      getElementById: id => missing ? null : { getBoundingClientRect: () => ({ ...MARKERS.find(marker => marker.id === id).css }) } },
    location: { href: "http://127.0.0.1:32100/" }, innerWidth: 886, innerHeight: 546, devicePixelRatio: 1.5, scrollX: 0, scrollY: 0,
    fetch: (url, request) => { assert.equal(url, "/witness"); reports.push(JSON.parse(request.body)); return Promise.resolve(); },
    setInterval: callback => { interval = callback; return 1; },
  };
  new vm.Script(source).runInNewContext(context, { timeout: 1000 });
  return { html, reports, listeners, send: () => interval() };
}

test("generated default and marker scripts execute and report the same bounded document/viewport", () => {
  for (const markers of [false, true]) {
    const f = page(markers), report = f.reports[0];
    assert.equal(report.nonce, nonce); assert.equal(report.documentId, "owned-document-1");
    assert.deepEqual(report.viewport, { width: 886, height: 546, dpr: 1.5, scrollX: 0, scrollY: 0 });
    assert.deepEqual(report.events, []);
    if (markers) assert.deepEqual(report.markers, MARKERS.map(marker => ({ id: marker.id, bounds: marker.css })));
    else assert.equal(report.markers, undefined);
    assert.equal(f.listeners.size, 10);
  }
});

test("the generated witness retains earlier input and does not invent clean reports at capacity", () => {
  const f = page(true);
  for (let i = 0; i < 40; i++) f.listeners.get("keydown")({ isTrusted: true });
  f.send();
  const report = f.reports.at(-1);
  assert.equal(report.events.length, 32);
  assert.deepEqual(report.events[0], { type: "keydown", trusted: true });
  assert.throws(() => assertReadonlyPixelWitness([{ ...report, received_ms: 100 }], nonce, report.location, 0, 100));
});

test("missing marker nodes cannot silently produce empty successful marker evidence", () => {
  assert.throws(() => page(true, true));
});

test("fixture input cannot inject foreign documents or executable markup", () => {
  for (const options of [{ title: "Other page", nonce }, { title, nonce: "</script>" }, { title, nonce, cssomMarkers: "true" }]) {
    assert.throws(() => createDomPixelPage(options));
  }
});
