// Tile placement. Pure functions, no DOM: unit tests import them.
//
// Justified rows, as in photo galleries: all tiles of a row share its height and their widths follow their windows'
// aspect ratios, so windows of different sizes fill the area with few holes. A tile is never larger than its window;
// a small window sits centred in its slot instead. When tiles would get smaller than MIN_SCALE of their windows, the
// rest go to further layers. LPT-1676 measured this against one common scale for all tiles (GNOME Shell's overview):
// justified rows fill 76-81 % of a 2560x1392 area against 62-68 %.

/** The smallest share of its window's size a tile may show at before windows move to another layer. */
export const MIN_SCALE = 0.45;

/**
 * Split windows, in their order, into `rows` rows of about equal aspect-ratio sums: rows that are equally tall when
 * they fill the width. No row is left empty.
 */
export function splitRows(windows, rows) {
  const aspect = w => w.width / w.height;
  const ideal = windows.reduce((sum, w) => sum + aspect(w), 0) / rows;
  const out = [];
  let row = [], sum = 0;
  windows.forEach((w, i) => {
    const left = windows.length - i, rowsLeft = rows - out.length;
    // A new row when this one would pass the ideal by more than half of this window, or when every later row needs one.
    if (row.length && out.length < rows - 1 && (sum + aspect(w) / 2 > ideal || left < rowsLeft)) { out.push(row); row = []; sum = 0; }
    row.push(w);
    sum += aspect(w);
  });
  if (row.length) out.push(row);
  return out;
}

/**
 * The tile height of a row that fills `width`: windows shorter than it show at their own size and give the rest of
 * the width to the others. The row is as tall as its tallest tile.
 */
function rowHeight(row, width) {
  let capped = new Set();
  for (;;) {
    const fixed = row.filter(w => capped.has(w)).reduce((sum, w) => sum + w.width, 0);
    const aspect = row.filter(w => !capped.has(w)).reduce((sum, w) => sum + w.width / w.height, 0);
    if (!aspect) return Math.max(...row.map(w => w.height));
    const h = (width - fixed) / aspect;
    const short = row.filter(w => !capped.has(w) && w.height < h);
    if (!short.length) return h;
    capped = new Set([...capped, ...short]);
  }
}

/**
 * Place rows of windows in `area` as justified rows: per window key its content rectangle and scale, with the caption
 * right above the rectangle. Undefined when the area has no room for these rows.
 */
function justify(rows, area, caption, gap) {
  const width = area.width - 2 * gap;
  const height = area.height - 2 * gap - (rows.length - 1) * gap - rows.length * caption;
  if (width <= 0 || height <= 0) return undefined;
  const heights = rows.map(row => {
    const free = width - (row.length - 1) * gap;
    return free > 0 ? rowHeight(row, free) : 0;
  });
  if (heights.some(h => h <= 0)) return undefined;
  // Rows taller than the area together shrink by one factor, which keeps them inside the width too.
  const fit = Math.min(1, height / heights.reduce((sum, h) => sum + h, 0));
  const block = heights.reduce((sum, h) => sum + h * fit, 0) + rows.length * caption + (rows.length - 1) * gap;
  const tiles = new Map();
  let y = area.y + (area.height - block) / 2, used = 0, smallest = Infinity;
  rows.forEach((row, r) => {
    const h = heights[r] * fit;
    const sizes = row.map(w => {
      const scale = Math.min(1, heights[r] / w.height) * fit;
      return { w, scale, width: w.width * scale, height: w.height * scale };
    });
    const rowWidth = sizes.reduce((sum, s) => sum + s.width, 0) + (row.length - 1) * gap;
    let x = area.x + (area.width - rowWidth) / 2;
    for (const s of sizes) {
      tiles.set(s.w.key, { x: Math.round(x), y: Math.round(y + caption + (h - s.height) / 2), width: Math.round(s.width), height: Math.round(s.height), scale: s.scale });
      used += s.width * (s.height + caption);
      smallest = Math.min(smallest, s.scale);
      x += s.width + gap;
    }
    y += h + caption + gap;
  });
  return { tiles, scale: smallest, fill: used / (area.width * area.height) };
}

/**
 * The justified layout of these windows that fills the most of the area among those whose tiles all keep `minScale`,
 * or undefined. Each row is at least `minScale` of its tallest window high and no two rows share that window, so `r`
 * rows need at least `minScale` times the `r` smallest window heights: row counts past that are never tried, which
 * keeps a long list on a small area cheap.
 */
function readableLayout(windows, area, caption, gap, minScale) {
  const heights = windows.map(w => w.height).sort((a, b) => a - b);
  let best, needed = 0;
  for (let rows = 1; rows <= windows.length; rows++) {
    needed += minScale * heights[rows - 1];
    if (needed > area.height - (rows + 1) * gap - rows * caption) break;
    const layout = justify(splitRows(windows, rows), area, caption, gap);
    if (layout && layout.scale >= minScale && (!best || layout.fill > best.fill + 1e-9)) best = layout;
  }
  return best;
}

/**
 * The justified layout of these windows that fills the most of the area, over every row count, among those whose
 * tiles all keep `minScale`; without such a row count, the one with the largest smallest tile.
 */
export function justifiedLayout(windows, area, { caption = 28, gap = 16, minScale = 0 } = {}) {
  const readable = readableLayout(windows, area, caption, gap, minScale);
  if (readable) return readable;
  let best;
  for (let rows = 1; rows <= windows.length; rows++) {
    const layout = justify(splitRows(windows, rows), area, caption, gap);
    if (layout && (!best || layout.scale > best.scale)) best = layout;
  }
  return best;
}

/**
 * How many windows from the start of `windows`, at most `limit`, fit on one layer with every tile at `minScale` or
 * larger; at least 1. The search starts no higher than the windows whose tiles at `minScale` cover the area at most
 * once, since tiles never overlap.
 */
function fitting(windows, area, { caption, gap, minScale }, limit = windows.length) {
  let count = 0;
  for (let covered = 0; count < Math.min(limit, windows.length); count++) {
    covered += minScale * minScale * windows[count].width * windows[count].height;
    if (covered > area.width * area.height) break;
  }
  while (count > 1 && !readableLayout(windows.slice(0, count), area, caption, gap, minScale)) count--;
  return Math.max(1, count);
}

/** The fewest layers these windows need in their order: each layer takes as many as fit. */
function layersNeeded(windows, area, options) {
  let layers = 0;
  for (let rest = windows; rest.length; layers++) rest = rest.slice(fitting(rest, area, options));
  return layers;
}

/**
 * Place windows as tiles in layers: as few layers as the windows need with every tile at least `minScale` of its
 * window, the windows split about evenly over them in their order, so no layer is a lone leftover. A window the area
 * has no room for at all gets its own layer without tiles. Returns the layers, each with its tiles per window key
 * (content rectangle and scale) and its smallest scale.
 */
export function layoutLayers(windows, area, { caption = 28, gap = 16, minScale = MIN_SCALE } = {}) {
  const options = { caption, gap, minScale };
  const layers = [];
  for (let rest = windows; rest.length;) {
    const left = layersNeeded(rest, area, options);
    // An even share of what is left, unless fewer of these windows fit on one layer.
    const count = fitting(rest, area, options, Math.ceil(rest.length / left));
    const layout = justifiedLayout(rest.slice(0, count), area, options);
    layers.push(layout ? { tiles: layout.tiles, scale: layout.scale } : { tiles: new Map(), scale: 0 });
    rest = rest.slice(count);
  }
  return layers;
}
