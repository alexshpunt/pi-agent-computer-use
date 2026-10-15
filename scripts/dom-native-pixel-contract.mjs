import assert from "node:assert/strict";

/** Check an independent owned-page report before retaining it in the bounded journal. */
export function validatePixelProbeReport(report, nonce) {
  assert.equal(report?.nonce, nonce);
  assert.ok(typeof report.documentId === "string" && report.documentId.length > 0 && report.documentId.length <= 64);
  assert.ok(Array.isArray(report.events) && report.events.length <= 32 && typeof report.location === "string");
  const viewport = report.viewport;
  assert.ok(viewport && [viewport.width, viewport.height, viewport.dpr, viewport.scrollX, viewport.scrollY].every(Number.isFinite));
  assert.ok(viewport.width > 0 && viewport.height > 0 && viewport.dpr > 0);
  return report;
}

/** A same-URL reload cannot hide input or substitute a new document during paired sampling. */
export function assertReadonlyPixelWitness(reports, nonce, url, rejected, now = Date.now()) {
  assert.ok(Array.isArray(reports) && reports.length > 0 && reports.length <= 1000);
  assert.equal(rejected, 0);
  for (const report of reports) {
    validatePixelProbeReport(report, nonce);
    assert.equal(report.location, url);
    assert.deepEqual(report.events, [], "Unexpected input cannot be hidden by a later report.");
  }
  assert.equal(new Set(reports.map(report => report.documentId)).size, 1, "Owned document changed during sampling.");
  const latest = reports.at(-1);
  assert.ok(Number.isFinite(latest.received_ms) && now - latest.received_ms >= 0 && now - latest.received_ms <= 5000, "Stale page witness.");
  return latest;
}

/** Release all connections of this task-owned server, including incomplete HTTP requests. */
export function closePixelProbeServer(server) {
  return new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
}
