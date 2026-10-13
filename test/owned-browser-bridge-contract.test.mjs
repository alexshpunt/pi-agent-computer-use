import assert from "node:assert/strict";
import { test } from "node:test";
import { assertBridgeDispatchAllowed, assertBridgeWitness, assertRetiredBridgeRef, assertSelectedBridgeTab } from "../scripts/owned-browser-bridge-contract.mjs";

const url = "http://127.0.0.1:1234/", title = "Pi owned bridge fixture";
const bound = () => ({ binding_quality: "exact", mutation_allowed: true, tabs: [{ active: true, url, title }] });
const witness = () => ({ received_ms: 100, count: 1, storage: "fixture", cookie: "fixture", previous: null,
  events: [{ type: "click", trusted: false, target: "advance" }] });
const verify = (report, rejected = 0, pages = ["one", "one"]) => assertBridgeWitness(report, "fixture", 1, rejected, pages, 200);

test("known native stale-ref refusal is accepted even when MCP isError is absent", () => {
  assert.doesNotThrow(() => assertRetiredBridgeRef({ structuredContent: { effect: "refused", error: { code: "browser_ref_stale" } } }));
  for (const structuredContent of [{ effect: "unknown" }, { effect: "unverifiable" }, { effect: "refused", error: { code: "other_error" } }])
    assert.throws(() => assertRetiredBridgeRef({ isError: true, structuredContent }));
});

test("a stop after readonly work blocks action and setup but not owned session cleanup", () => {
  assert.throws(() => assertBridgeDispatchAllowed(true, "browser_click"));
  assert.throws(() => assertBridgeDispatchAllowed(true, "browser_prepare"));
  assert.throws(() => assertBridgeDispatchAllowed(true, "interactive_wait"));
  assert.doesNotThrow(() => assertBridgeDispatchAllowed(true, "end_session"));
  assert.doesNotThrow(() => assertBridgeDispatchAllowed(false, "browser_click"));
});

test("exact binding cannot substitute another, inactive or ambiguous tab for native pixels", () => {
  assert.doesNotThrow(() => assertSelectedBridgeTab(bound(), url, title));
  for (const changed of [{ binding_quality: "heuristic" }, { mutation_allowed: false }, { tabs: [] },
    { tabs: [...bound().tabs, ...bound().tabs] }, { tabs: [{ active: false, url, title }] },
    { tabs: [{ active: true, url: url + "other", title }] }, { tabs: [{ active: true, url, title: "other" }] }])
    assert.throws(() => assertSelectedBridgeTab({ ...bound(), ...changed }, url, title));
});

test("only one untrusted synthetic click can pass the independent mutation witness", () => {
  assert.doesNotThrow(() => verify(witness()));
  for (const events of [[], [...witness().events, ...witness().events], [{ type: "click", trusted: true, target: "advance" }],
    [...witness().events, { type: "keydown", trusted: true, target: "" }]])
    assert.throws(() => verify({ ...witness(), events }));
  assert.doesNotThrow(() => assertBridgeWitness({ ...witness(), count: 0, events: [] }, "fixture", 0, 0, ["one"], 200));
  assert.throws(() => assertBridgeWitness({ ...witness(), count: 0 }, "fixture", 0, 0, ["one"], 200));
});

test("stale, rejected or replaced-page evidence cannot prove cookie and storage continuity", () => {
  for (const changed of [{ received_ms: -1401 }, { received_ms: 201 }, { count: 2 }, { cookie: "other" },
    { storage: "other" }, { previous: "earlier profile" }]) assert.throws(() => verify({ ...witness(), ...changed }));
  assert.throws(() => verify(witness(), 1));
  assert.throws(() => verify(witness(), 0, ["one", "replacement"]));
});
