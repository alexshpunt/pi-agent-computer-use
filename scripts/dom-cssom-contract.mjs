import assert from "node:assert/strict";

/** Compare one readonly CSSOM sample with an independent synthetic-page witness.
 * This proves neither native pixels nor atomic DOM/paint correspondence.
 */
export function assertCssomWitness(sample, { page, reference, report, nodeId, now = Date.now() }) {
  assert.equal(sample?.status, "ok");
  assert.equal(sample.mode, "element_geometry");
  assert.equal(sample.target_id, page.target_id);
  assert.equal(sample.tab_id, page.tab_id);
  assert.equal(sample.ref, reference);
  assert.equal(sample.source_ref, reference);
  assert.equal(sample.frame?.kind, "main");
  assert.equal(sample.coordinate_space, "frame_viewport_css_pixels");
  assert.equal(sample.viewport, "layout");
  assert.equal(sample.method, "isolated_cssom_border_box");
  assert.equal(sample.native_pixel_mapping, "unavailable");
  assert.equal(sample.atomic, false);
  assert.equal(sample.connected, true);
  assert.equal(sample.same_document, true);
  assert.ok(report && report.page === "root" && report.geometrySpace === "css_viewport_pixels");
  assert.ok(now - report.received_ms >= 0 && now - report.received_ms <= 5000, "Fresh independent CSS witness required.");
  assert.deepEqual(report.events, []);
  assert.equal(report.eventOverflow, false);
  const nodes = report.nodes.filter(node => node.id === nodeId);
  assert.equal(nodes.length, 1, "Require one exact node from the attested main document.");
  assert.equal(nodes[0].connected, true);
  assert.deepEqual(sample.bounds, nodes[0].bounds, "Viewport CSS coordinates must agree without DPR conversion.");
  assert.deepEqual(sample.scroll, { x: report.viewport.scroll_x, y: report.viewport.scroll_y });
  for (const [object, fields] of [[sample.bounds, ["x", "y", "width", "height"]],
    [sample.scroll, ["x", "y"]],
    [sample.visual_viewport, ["offset_x", "offset_y", "page_x", "page_y", "width", "height", "scale"]]]) {
    assert.ok(object && Object.keys(object).length === fields.length);
    assert.ok(fields.every(field => Number.isFinite(object[field]) && Math.abs(object[field]) <= 1e9));
  }
  assert.ok(sample.bounds.width >= 0 && sample.bounds.height >= 0);
  assert.ok(sample.visual_viewport.width > 0 && sample.visual_viewport.height > 0 && sample.visual_viewport.scale > 0);
  return { node: nodeId, source_ref: reference, page_nonce: report.pageNonce, witness_serial: report.serial,
    bounds: structuredClone(sample.bounds), scroll: structuredClone(sample.scroll), native_mapping_qualified: false };
}
