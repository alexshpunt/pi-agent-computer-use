const marker = (id, color, css) => Object.freeze({ id, color: Object.freeze(color), css: Object.freeze(css) });

/** Fixed declarations for the owned synthetic fixture, not arbitrary page targets. */
export const MARKERS = Object.freeze([
  marker("geometry-a", [13, 201, 173], { x: 80, y: 50, width: 24, height: 24 }),
  marker("geometry-b", [83, 17, 229], { x: 360, y: 140, width: 24, height: 24 }),
  marker("geometry-c", [211, 151, 3], { x: 130, y: 340, width: 24, height: 24 }),
]);
const fields = ["x", "y", "width", "height"];
const colors = new Map(MARKERS.map(({ color }, index) => [(color[0] << 16) | (color[1] << 8) | color[2], index]));
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const check = (condition, reason) => { if (!condition) throw Error(reason); };

/** Verify only the declared fixture's CSS-to-private-raster hypothesis.
 * The caller owns document/source continuity and supplies independently checked CSSOM samples.
 * No native pixel correspondence, capture, crop, visibility or input authority is established.
 */
export function verifyMarkerRaster(rgba, width, height, samples, reportedDpr) {
  check(Number.isSafeInteger(width) && Number.isSafeInteger(height) && width > 0 && height > 0 &&
    Number.isSafeInteger(width * height) && width * height <= 16_000_000 &&
    rgba instanceof Uint8Array && rgba.length === width * height * 4, "dom_marker_invalid_image");
  check(Number.isFinite(reportedDpr) && reportedDpr >= 0.25 && reportedDpr <= 8, "dom_marker_invalid_dpr");
  check(Array.isArray(samples) && samples.length === MARKERS.length, "dom_marker_invalid_samples");
  const byId = new Map();
  for (const sample of samples) {
    check(object(sample) && typeof sample.id === "string" && sample.id.length <= 64 &&
      MARKERS.some(marker => marker.id === sample.id) && !byId.has(sample.id), "dom_marker_invalid_samples");
    byId.set(sample.id, sample);
  }
  const expected = MARKERS.map(marker => {
    const bounds = byId.get(marker.id)?.bounds;
    check(object(bounds) && fields.every(field => bounds[field] === marker.css[field]), "dom_marker_css_source_unqualified");
    const bitmap = Object.fromEntries(fields.map(field => [field, bounds[field] * reportedDpr]));
    check(fields.every(field => Number.isSafeInteger(bitmap[field])) && bitmap.width > 0 && bitmap.height > 0,
      "dom_marker_transform_unqualified: fractional raster boundary");
    check(bitmap.x >= 0 && bitmap.y >= 0 && bitmap.x + bitmap.width <= width && bitmap.y + bitmap.height <= height,
      "dom_marker_transform_unqualified: outside bitmap");
    return bitmap;
  });
  // Storage is constant-sized. Reserve no image-sized working array or candidate list.
  const found = MARKERS.map(() => ({ count: 0, left: width, top: height, right: -1, bottom: -1 }));
  let offset = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++, offset += 4) {
      const index = colors.get((rgba[offset] << 16) | (rgba[offset + 1] << 8) | rgba[offset + 2]);
      if (index === undefined) continue;
      check(rgba[offset + 3] === 255, `dom_marker_translucent: ${MARKERS[index].id}`);
      const region = found[index];
      region.count++;
      region.left = Math.min(region.left, x); region.top = Math.min(region.top, y);
      region.right = Math.max(region.right, x); region.bottom = Math.max(region.bottom, y);
    }
  }
  const markers = MARKERS.map((marker, index) => {
    const region = found[index];
    check(region.count > 0, `dom_marker_not_found: ${marker.id}`);
    const bitmap = { x: region.left, y: region.top, width: region.right - region.left + 1, height: region.bottom - region.top + 1 };
    check(region.count === bitmap.width * bitmap.height, `dom_marker_ambiguous: ${marker.id}`);
    check(fields.every(field => bitmap[field] === expected[index][field]), `dom_marker_transform_unqualified: ${marker.id}`);
    return { id: marker.id, css_bounds: { ...marker.css }, bitmap_bounds: bitmap };
  });
  return { method: "exact_declared_css_markers", origin: { x: 0, y: 0 }, scale_x: reportedDpr, scale_y: reportedDpr,
    markers, native_pixel_mapping_qualified: false, qualification_scope: "declared fixture and recorded raster only" };
}
