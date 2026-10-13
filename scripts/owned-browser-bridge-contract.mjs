import assert from "node:assert/strict";

/** Prove that native pixels show the one selected synthetic tab; never rebind action IDs. */
export function assertSelectedBridgeTab(bound, url, title) {
  assert.equal(bound.binding_quality, "exact"); assert.equal(bound.mutation_allowed, true);
  assert.equal(bound.tabs.length, 1, "Native pixels cannot represent an ambiguous/inactive DOM tab.");
  assert.equal(bound.tabs[0].active, true); assert.equal(bound.tabs[0].url, url);
  assert.equal(bound.tabs[0].title, title);
}

/** Check fresh independent same-page cookie/storage continuity and the exact authorized event journal. */
export function assertBridgeWitness(report, nonce, count, rejected, pageNonces, now = Date.now()) {
  assert.ok(report && now - report.received_ms >= 0 && now - report.received_ms <= 1500, "Missing/stale independent page witness.");
  assert.equal(report.count, count); assert.equal(report.storage, nonce); assert.equal(report.cookie, nonce);
  assert.equal(report.previous, null, "Isolated profile must start with no prior fixture storage.");
  assert.deepEqual(report.events, count === 0 ? [] : [{ type: "click", trusted: false, target: "advance" }],
    "Only the single explicit synthetic DOM click is authorized; no trusted/keyboard/pointer input.");
  assert.equal(rejected, 0, "Rejected witness reports are not a clean acceptance.");
  assert.equal(new Set(pageNonces).size, 1, "Page/context was replaced.");
}

/** Require the known stale-ref refusal rather than accepting an interrupted or unverified outcome. */
export function assertRetiredBridgeRef(result) {
  assert.equal(result?.structuredContent?.effect, "refused", "Old snapshot must refuse without mutation.");
  assert.equal(result.structuredContent.error?.code, "browser_ref_stale", "Unknown or unrelated refusal is not the stale-ref contract.");
}

/** Stop future dispatch after cancellation; session cleanup must remain possible. */
export function assertBridgeDispatchAllowed(stopping, name) {
  assert.ok(!stopping || name === "end_session", "Stopped; do not dispatch another operation.");
}
