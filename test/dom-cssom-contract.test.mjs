import assert from "node:assert/strict";
import test from "node:test";
import { assertCssomWitness } from "../scripts/dom-cssom-contract.mjs";

function fixture() {
  const bounds = { x: 191.09375, y: 182.89584350585938, width: 241.33334350585938, height: 36.66666793823242 };
  const sample = { status: "ok", mode: "element_geometry", target_id: "owned-target", tab_id: "owned-tab",
    ref: "p1:0", source_ref: "p1:0", frame: { kind: "main" }, coordinate_space: "frame_viewport_css_pixels",
    viewport: "layout", method: "isolated_cssom_border_box", native_pixel_mapping: "unavailable", atomic: false,
    connected: true, same_document: true, bounds, scroll: { x: 0, y: 120 },
    visual_viewport: { offset_x: 0, offset_y: 0, page_x: 0, page_y: 120, width: 886, height: 546, scale: 1 } };
  const options = { page: { target_id: "owned-target", tab_id: "owned-tab" }, reference: "p1:0", nodeId: "value", now: 1000,
    report: { page: "root", pageNonce: "c0b0957d-861f-4ddd-8781-707d2f32d32f", serial: 2, received_ms: 900,
      geometrySpace: "css_viewport_pixels", events: [], eventOverflow: false,
      viewport: { scroll_x: 0, scroll_y: 120, device_pixel_ratio: 1.5 }, nodes: [{ id: "value", connected: true, bounds: structuredClone(bounds) }] } };
  return { sample, options };
}

test("fractional viewport CSS values are checked without dividing by non-unit DPR", () => {
  const { sample, options } = fixture();
  const proof = assertCssomWitness(sample, options);
  assert.deepEqual(proof.bounds, sample.bounds);
  assert.equal(proof.native_mapping_qualified, false);
  proof.bounds.x = 0;
  assert.notEqual(sample.bounds.x, 0);
  for (const factor of [1.5, 1 / 1.5]) {
    const scaled = structuredClone(sample);
    for (const key of Object.keys(scaled.bounds)) scaled.bounds[key] *= factor;
    assert.throws(() => assertCssomWitness(scaled, options));
  }
});

test("foreign, stale, detached and claimed native-pixel sources cannot pass CSS qualification", () => {
  for (const [field, value] of [["status", "refused"], ["mode", "snapshot"], ["target_id", "foreign"], ["tab_id", "foreign"],
    ["ref", "p0:0"], ["source_ref", "p0:0"], ["coordinate_space", "document_css_pixels"], ["viewport", "visual"],
    ["method", "guessed_dpr"], ["native_pixel_mapping", "qualified"], ["atomic", true], ["connected", false], ["same_document", false]]) {
    const { sample, options } = fixture(); sample[field] = value;
    assert.throws(() => assertCssomWitness(sample, options), field);
  }
  const { sample, options } = fixture(); sample.frame.kind = "iframe";
  assert.throws(() => assertCssomWitness(sample, options));
});

test("all retained input and independent witness freshness matter, not only matching rectangles", () => {
  for (const mutate of [report => { report.events.push({ type: "click", trusted: false, target: "value" }); },
    report => { report.eventOverflow = true; }, report => { report.page = "cross"; },
    report => { report.received_ms = -5000; }, report => { report.received_ms = 1001; },
    report => { report.nodes[0].connected = false; }, report => { report.nodes.push(structuredClone(report.nodes[0])); }]) {
    const { sample, options } = fixture(); mutate(options.report);
    assert.throws(() => assertCssomWitness(sample, options));
  }
});

test("malformed visual viewport data and hidden geometry conversions are not accepted", () => {
  for (const [field, value] of [["width", 0], ["height", -1], ["scale", 0], ["offset_x", Number.NaN], ["page_y", Infinity]]) {
    const { sample, options } = fixture(); sample.visual_viewport[field] = value;
    assert.throws(() => assertCssomWitness(sample, options));
  }
  const { sample, options } = fixture(); sample.bounds.native_x = 20;
  assert.throws(() => assertCssomWitness(sample, options));
});
