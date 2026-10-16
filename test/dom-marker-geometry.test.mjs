import assert from "node:assert/strict";
import test from "node:test";
import { MARKERS, verifyMarkerRaster } from "../scripts/dom-marker-geometry.mjs";

function fixture(dpr = 1, { scaleY = dpr, offsetX = 0, offsetY = 0 } = {}) {
  const width = 800 * dpr, height = 500 * Math.max(dpr, scaleY);
  const rgba = new Uint8Array(width * height * 4).fill(255);
  const samples = MARKERS.map(marker => ({ id: marker.id, bounds: { ...marker.css } }));
  const paint = (bounds, color, alpha = 255) => {
    for (let y = bounds.y; y < bounds.y + bounds.height; y++) {
      for (let x = bounds.x; x < bounds.x + bounds.width; x++) rgba.set([...color, alpha], (y * width + x) * 4);
    }
  };
  for (const marker of MARKERS) paint({ x: marker.css.x * dpr + offsetX, y: marker.css.y * scaleY + offsetY,
    width: marker.css.width * dpr, height: marker.css.height * scaleY }, marker.color);
  return { rgba, width, height, samples, dpr, paint };
}
const verify = (f, dpr = f.dpr) => verifyMarkerRaster(f.rgba, f.width, f.height, f.samples, dpr);

test("declared markers verify exact integer raster boundaries at DPR 1, 1.5 and 2", () => {
  for (const dpr of [1, 1.5, 2]) {
    const f = fixture(dpr), proof = verify(f);
    assert.deepEqual(proof, { method: "exact_declared_css_markers", origin: { x: 0, y: 0 }, scale_x: dpr, scale_y: dpr,
      markers: MARKERS.map(marker => ({ id: marker.id, css_bounds: marker.css, bitmap_bounds: {
        x: marker.css.x * dpr, y: marker.css.y * dpr, width: marker.css.width * dpr, height: marker.css.height * dpr,
      } })), native_pixel_mapping_qualified: false, qualification_scope: "declared fixture and recorded raster only" });
  }
});

test("translation, unequal axis scale and wrong DPR cannot be fitted or retried", () => {
  for (const options of [{ offsetX: 1 }, { offsetY: -1 }, { scaleY: 2 }]) {
    assert.throws(() => verify(fixture(1.5, options)), /dom_marker_transform_unqualified/);
  }
  assert.throws(() => verify(fixture(1.5), 1), /dom_marker_transform_unqualified/);
});

test("fractional raster boundaries refuse rather than round coordinates", () => {
  const f = fixture();
  assert.throws(() => verify(f, 1.25), /dom_marker_transform_unqualified/);
  f.samples[0].bounds.y += Number.EPSILON * 50;
  assert.throws(() => verify(f), /dom_marker_css_source_unqualified/);
});

test("missing and disjoint duplicate colors cannot establish correspondence", () => {
  const missing = fixture();
  missing.paint(MARKERS[0].css, [255, 255, 255]);
  assert.throws(() => verify(missing), /dom_marker_not_found/);
  const duplicate = fixture();
  duplicate.paint({ x: 600, y: 400, width: 2, height: 2 }, MARKERS[0].color);
  assert.throws(() => verify(duplicate), /dom_marker_ambiguous/);
});

test("every matching marker pixel must be opaque, while unrelated alpha is not proof", () => {
  const f = fixture();
  f.rgba[3] = 0;
  assert.equal(verify(f).native_pixel_mapping_qualified, false);
  f.rgba[(MARKERS[0].css.y * f.width + MARKERS[0].css.x) * 4 + 3] = 0;
  assert.throws(() => verify(f), /dom_marker_translucent/);
});

test("a damaged marker is not a complete solid rectangle", () => {
  const f = fixture();
  f.paint({ x: MARKERS[1].css.x + 3, y: MARKERS[1].css.y + 3, width: 1, height: 1 }, [255, 255, 255]);
  assert.throws(() => verify(f), /dom_marker_ambiguous/);
});

test("malformed dimensions, byte counts and oversized images fail before scanning", () => {
  for (const [rgba, width, height] of [[new Uint8Array(0), 0, 1], [new Uint8Array(4), 1.5, 1],
    [new Uint8Array(0), 16_000_001, 1], [new Uint8Array(0), Number.MAX_SAFE_INTEGER, 2],
    [new Uint8Array(3), 1, 1], [new Uint8Array(5), 1, 1], [[], 1, 1], [null, 1, 1]]) {
    assert.throws(() => verifyMarkerRaster(rgba, width, height, [], 1), /dom_marker_invalid_image/);
  }
  const f = fixture();
  for (const dpr of [NaN, Infinity, 0, 0.24, 8.01, "1"]) assert.throws(() => verify(f, dpr), /dom_marker_invalid_dpr/);
});

test("samples must identify exactly the three declared CSS rectangles", () => {
  for (const change of [f => { f.samples.pop(); }, f => { f.samples.push(f.samples[0]); },
    f => { f.samples[1].id = f.samples[0].id; }, f => { f.samples[1].id = "foreign"; },
    f => { f.samples[0].bounds.width = 0; }, f => { f.samples[0].bounds.x = NaN; },
    f => { f.samples[0].bounds = null; }]) {
    const f = fixture(); change(f);
    assert.throws(() => verify(f), /dom_marker_(invalid_samples|css_source_unqualified)/);
  }
});

test("output is projected and independent; input pixels, samples and declared markers are unchanged", () => {
  const f = fixture(), bytes = f.rgba.slice(), samples = structuredClone(f.samples);
  f.samples[0].native_secret = "not a capability";
  const proof = verify(f);
  assert.deepEqual(f.rgba, bytes);
  assert.deepEqual(f.samples.map(({ id, bounds }) => ({ id, bounds })), samples);
  assert.equal(JSON.stringify(proof).includes("native_secret"), false);
  proof.markers[0].css_bounds.x = 0;
  proof.markers[0].bitmap_bounds.y = 0;
  assert.equal(f.samples[0].bounds.x, 80);
  assert.equal(MARKERS[0].css.x, 80);
  assert.throws(() => { MARKERS[0].color[0] = 255; }, TypeError);
});
