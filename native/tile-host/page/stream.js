// Pure helpers for the session stream protocol (docs/session-streams.md); no DOM, so unit tests import them.

/** The WebCodecs codec string ("avc1.PPCCLL") from the SPS in an Annex B access unit, or undefined without an SPS. */
export function codecFromAnnexB(bytes) {
  for (let i = 0; i + 3 < bytes.length; i++) {
    if (bytes[i] !== 0 || bytes[i + 1] !== 0) continue;
    let start;
    if (bytes[i + 2] === 1) start = i + 3;
    else if (bytes[i + 2] === 0 && bytes[i + 3] === 1) start = i + 4;
    else continue;
    if ((bytes[start] & 0x1f) === 7 && start + 3 < bytes.length)
      return "avc1." + [bytes[start + 1], bytes[start + 2], bytes[start + 3]].map(b => b.toString(16).padStart(2, "0")).join("");
    i = start - 1;
  }
  return undefined;
}

/** Split one binary hub message into its JSON header and H.264 payload. */
export function parseFrame(buffer) {
  const view = new DataView(buffer);
  const length = view.getUint32(0);
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 4, length)));
  return { header, payload: new Uint8Array(buffer, 4 + length) };
}

const MIN_SIDE = 40;

/**
 * The windows of a session that get a tile: app windows and dialogs on screen, not minimized, of a visible size.
 * Tooltips, menus, system windows and transparent overlays (such as cua-spacesd's own cursor overlay) get none.
 */
export function tileWindows(windows) {
  return windows.filter(w => w.onScreen && w.state !== "minimized" && w.state !== "hidden"
    && (w.kind === "standard" || w.kind === "dialog" || w.kind === "unspecified")
    && w.bounds.width >= MIN_SIDE && w.bounds.height >= MIN_SIDE && !/^Cua\./.test(w.title) && !/^cua-/i.test(w.app));
}

/**
 * Keep tiles in a stable order: windows already shown keep their place, new ones go to the end. `order` maps a
 * window id to its first-seen index and is updated in place.
 */
export function stableOrder(windows, order) {
  for (const w of windows) if (!order.has(w.id)) order.set(w.id, order.size);
  return [...windows].sort((a, b) => order.get(a.id) - order.get(b.id));
}

/** A frame size the hub can use for a tile: the tile's longer side in device pixels, in steps of 64. */
export function maxDimensionFor(width, height, devicePixelRatio) {
  const side = Math.max(width, height) * devicePixelRatio;
  return Math.min(8192, Math.max(64, Math.ceil(side / 64) * 64));
}

/** The agent cursor's place in a tile: the activity point relative to the window, scaled to the tile's content. */
export function cursorInTile(point, bounds, scale) {
  if (!point) return undefined;
  const x = (point.x - bounds.x) * scale, y = (point.y - bounds.y) * scale;
  if (x < 0 || y < 0 || x > bounds.width * scale || y > bounds.height * scale) return undefined;
  return { x, y };
}
