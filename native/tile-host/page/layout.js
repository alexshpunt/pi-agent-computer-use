// Tile placement. Pure function, no DOM: unit tests import it.

/**
 * Place windows as tiles in a grid inside `area`. Every tile keeps its window's aspect ratio and is never larger than
 * the window (scale <= 1); the column count is the one whose smallest tile is largest, then whose shape best fits the
 * area. `caption` is the height of the bar above each tile's content, `gap` the space around tiles. Returns, per
 * window key, the content rectangle and its scale; the caption sits right above the rectangle.
 */
export function gridLayout(windows, area, { caption = 28, gap = 16 } = {}) {
  const placed = new Map();
  const n = windows.length;
  if (!n || area.width <= 0 || area.height <= 0) return placed;
  let best;
  for (let columns = 1; columns <= n; columns++) {
    const rows = Math.ceil(n / columns);
    const cellWidth = (area.width - gap * (columns + 1)) / columns;
    const cellHeight = (area.height - gap * (rows + 1)) / rows - caption;
    if (cellWidth <= 0 || cellHeight <= 0) continue;
    const scales = windows.map(w => Math.min(1, cellWidth / w.width, cellHeight / w.height));
    const smallest = Math.min(...scales);
    // Among equally large tiles, the grid whose shape is closest to the area's.
    const widest = Math.max(...windows.map((w, i) => w.width * scales[i])), tallest = Math.max(...windows.map((w, i) => w.height * scales[i]));
    const misfit = Math.abs(Math.log((columns * widest) / (rows * (tallest + caption)) / (area.width / area.height)));
    if (!best || smallest > best.smallest + 1e-9 || (Math.abs(smallest - best.smallest) <= 1e-9 && misfit < best.misfit))
      best = { columns, rows, cellWidth, cellHeight, scales, smallest, misfit };
  }
  if (!best) return placed;
  const { columns, rows, cellWidth, cellHeight, scales } = best;
  // Rows are centred vertically as a block, and the last row's tiles horizontally.
  const blockHeight = rows * (cellHeight + caption) + (rows - 1) * gap;
  const top = area.y + Math.max(gap, (area.height - blockHeight) / 2);
  windows.forEach((w, i) => {
    const row = Math.floor(i / columns), column = i % columns;
    const inRow = row === rows - 1 ? n - row * columns : columns;
    const rowWidth = inRow * cellWidth + (inRow - 1) * gap;
    const left = area.x + (area.width - rowWidth) / 2 + column * (cellWidth + gap);
    const scale = scales[i], width = w.width * scale, height = w.height * scale;
    const y = top + row * (cellHeight + caption + gap) + caption + (cellHeight - height) / 2;
    placed.set(w.key, { x: Math.round(left + (cellWidth - width) / 2), y: Math.round(y), width: Math.round(width), height: Math.round(height), scale });
  });
  return placed;
}
