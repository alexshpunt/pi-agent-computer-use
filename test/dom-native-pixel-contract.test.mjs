import assert from "node:assert/strict";
import { createServer } from "node:http";
import { connect } from "node:net";
import { test } from "node:test";
import { assertReadonlyPixelWitness, closePixelProbeServer, validatePixelProbeReport } from "../scripts/dom-native-pixel-contract.mjs";

const nonce = "owned-nonce", url = "http://127.0.0.1:4000/";
const report = () => ({ nonce, documentId: "original-document", events: [], location: url, received_ms: 100,
  viewport: { width: 900, height: 600, dpr: 1.5, scrollX: 0, scrollY: 0 } });

test("final history catches dirty reports after the last fresh sampling witness", async () => {
  const { assertReadonlyPixelHistory } = await import("../scripts/dom-native-pixel-contract.mjs");
  for (const late of [
    { ...report(), events: [{ type: "keydown" }] },
    { ...report(), documentId: "replacement-document" },
    { ...report(), location: "http://foreign/" },
  ]) {
    const history = [report()];
    assertReadonlyPixelWitness(history, nonce, url, 0, 200);
    history.push(late);
    assert.throws(() => assertReadonlyPixelHistory(history, nonce, url, 0));
  }
  assert.throws(() => assertReadonlyPixelHistory([report()], nonce, url, 1));
  // Integrity after shutdown is separate from freshness at the sampling boundary.
  assert.equal(assertReadonlyPixelHistory([report()], nonce, url, 0).documentId, "original-document");
});

test("fresh same-document readonly reports retain CSS viewport metadata without input authority", () => {
  const records = [report(), { ...report(), received_ms: 300 }];
  assert.equal(assertReadonlyPixelWitness(records, nonce, url, 0, 400), records[1]);
});
test("same-URL reloads, erased earlier input, stale reports and rejected journals refuse", () => {
  assert.throws(() => assertReadonlyPixelWitness([report(), { ...report(), documentId: "new-document" }], nonce, url, 0, 200));
  assert.throws(() => assertReadonlyPixelWitness([{ ...report(), events: [{ type: "keydown" }] }, report()], nonce, url, 0, 200));
  for (const now of [99, 5101]) assert.throws(() => assertReadonlyPixelWitness([report()], nonce, url, 0, now));
  assert.throws(() => assertReadonlyPixelWitness([report()], nonce, url, 1, 200));
  assert.throws(() => assertReadonlyPixelWitness([{ ...report(), location: "http://foreign/" }], nonce, url, 0, 200));
});
test("missing source identity and malformed CSS geometry are not an empty-success witness", () => {
  for (const change of [value => value.documentId = "", value => value.nonce = "foreign", value => value.viewport.dpr = 0,
    value => value.viewport.width = Infinity, value => value.events = Array(33).fill({ type: "click" })]) {
    const value = report(); change(value); assert.throws(() => validatePixelProbeReport(value, nonce));
  }
});
test("owned server release finishes even with an active incomplete HTTP request", async () => {
  const server = createServer(() => {});
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const socket = connect(server.address().port, "127.0.0.1");
  let timer;
  try {
    await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
    socket.write("POST /witness HTTP/1.1\r\nHost: localhost\r\nContent-Length: 100\r\n\r\npartial");
    await Promise.race([closePixelProbeServer(server), new Promise((_, reject) => { timer = setTimeout(() => reject(Error("Unbounded release")), 1500); })]);
    assert.equal(server.listening, false);
  } finally {
    clearTimeout(timer); socket.destroy(); if (server.listening) await closePixelProbeServer(server);
  }
});
