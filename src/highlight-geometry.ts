import type { DetailRequest } from "./native-detail.ts";

/** Physical Windows screen bounds. These are rendering metadata, never input authority. */
export interface ScreenRect { x: number; y: number; width: number; height: number }
/** Original CUA pixel scale and window-local inset; current screen position is supplied when drawing. */
export interface WindowImageMapping { offsetX: number; offsetY: number; scale: number }

/** Validate native geometry without manufacturing missing coordinates. */
export function screenRect(value: unknown): ScreenRect | undefined {
  const r = value as ScreenRect | undefined;
  if (!r || ![r.x, r.y, r.width, r.height].every(Number.isFinite) || r.width <= 0 || r.height <= 0) return;
  const x = Math.floor(r.x); const y = Math.floor(r.y);
  return { x, y, width: Math.ceil(r.x + r.width) - x, height: Math.ceil(r.y + r.height) - y };
}

/** Clip native AX bounds to the observed window, rounding outwards once. */
export function elementRegion(value: unknown, bounds: ScreenRect): ScreenRect | undefined {
  const frame = value as { x: number; y: number; w: number; h: number } | undefined;
  if (!frame) return;
  return clipRect(screenRect({ x: frame.x, y: frame.y, width: frame.w, height: frame.h }), bounds);
}

/** Keep every primitive inside its authorized source. Empty intersections are unavailable. */
export function clipRect(region: ScreenRect | undefined, bounds: ScreenRect): ScreenRect | undefined {
  if (!region) return;
  const x = Math.max(bounds.x, region.x); const y = Math.max(bounds.y, region.y);
  const right = Math.min(bounds.x + bounds.width, region.x + region.width);
  const bottom = Math.min(bounds.y + bounds.height, region.y + region.height);
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : undefined;
}

const nativeRound = (n: number) => Math.sign(n) * Math.floor(Math.abs(n) + 0.5);

/**
 * CUA 0.33.2 maps window pixels from DWM's visible origin plus a 1px inset and
 * one uniform native-width/returned-width scale. Windows does not publish that
 * scale. Recover it only when its rounded AX screenshot frames prove one unique
 * integer native width; otherwise leave the mark unavailable. No capture or bind.
 */
export function windowImageMapping(state: Record<string, unknown>): WindowImageMapping | undefined {
  const bounds = screenRect(state.window_bounds);
  const width = state.screenshot_width as number;
  if (!bounds || !Number.isSafeInteger(width) || width <= 0) return;
  const x = bounds.x + 1; const y = bounds.y + 1;
  const elements = (Array.isArray(state.elements) ? state.elements : []) as { frame?: { x: number; y: number; w: number; h: number }; screenshot_frame?: { x: number; y: number; w: number; h: number } }[];
  const witnesses = elements.filter(e => e.frame && e.screenshot_frame &&
    [e.frame.x, e.frame.y, e.frame.w, e.frame.h, e.screenshot_frame.x, e.screenshot_frame.y, e.screenshot_frame.w, e.screenshot_frame.h].every(Number.isFinite) &&
    e.frame.w > 0 && e.frame.h > 0 && e.screenshot_frame.w > 0 && e.screenshot_frame.h > 0);
  if (!witnesses.length) return;
  let low = 1; let high = 32768;
  for (const e of witnesses) {
    for (const axis of ["w", "h"] as const) {
      const a = width * e.frame![axis]; const m = e.screenshot_frame![axis];
      low = Math.max(low, Math.floor(a / (m + 0.5)) + 1);
      high = Math.min(high, Math.floor(a / (m - 0.5)));
    }
  }
  // Small/rounded frames may not identify the native width. Never choose a likely ratio.
  if (high < low || high - low > 32) return;
  const candidates: number[] = [];
  for (let nativeWidth = low; nativeWidth <= high; nativeWidth++) {
    const s = width / nativeWidth;
    if (witnesses.every(e => {
      const f = e.frame!; const p = e.screenshot_frame!;
      return nativeRound((f.x - x) * s) === p.x && nativeRound((f.y - y) * s) === p.y &&
        nativeRound(f.w * s) === p.w && nativeRound(f.h * s) === p.h;
    })) candidates.push(nativeWidth);
  }
  if (candidates.length === 1) return { offsetX: x - bounds.x, offsetY: y - bounds.y, scale: candidates[0] / width };
}

/** Keep the original local region and scale, move to current bounds, then clip. Native JPEG padding is not exposed. */
export function windowRegion(request: DetailRequest, mapping: WindowImageMapping | undefined, bounds: ScreenRect): ScreenRect | undefined {
  if (!mapping) return;
  return clipRect(screenRect({ x: bounds.x + mapping.offsetX + request.x * mapping.scale, y: bounds.y + mapping.offsetY + request.y * mapping.scale,
    width: request.width * mapping.scale, height: request.height * mapping.scale }), bounds);
}

/**
 * Windows 0.33.2's successful pixel-click receipts report the resolved physical
 * point. Read that point after the single dispatch: capture_id uses a separate
 * per-axis transform whose native height is not published in window overviews.
 * Unknown/new receipt formats produce no mark, never a guessed point or retry.
 */
export function nativeClickPoint(content: { type: string; text?: string }[], pid: number, bounds: ScreenRect): { x: number; y: number } | undefined {
  const texts = content.filter(b => b.type === "text").map(b => b.text ?? "");
  const patterns = [
    /^✅ (?:Posted click to Chromium|Injected click to) pid (\d+) at \((-?\d+),(-?\d+)\) \(background, no foreground swap\)\.$/,
    /^✅ Sent click via SendInput to pid (\d+) at \((-?\d+),(-?\d+)\) \(delivery_mode:foreground\)\.$/,
    /^✅ Performed UIA Invoke at \((-?\d+),(-?\d+)\) for pid (\d+)\.$/,
  ];
  for (const text of texts) {
    for (let i = 0; i < patterns.length; i++) {
      const m = patterns[i].exec(text);
      if (!m) continue;
      const owner = Number(m[i === 2 ? 3 : 1]);
      const point = { x: Number(m[i === 2 ? 1 : 2]), y: Number(m[i === 2 ? 2 : 3]) };
      if (owner === pid && [point.x, point.y].every(Number.isSafeInteger) && point.x >= bounds.x && point.y >= bounds.y &&
        point.x < bounds.x + bounds.width && point.y < bounds.y + bounds.height) return point;
    }
  }
}
