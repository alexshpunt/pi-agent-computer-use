// Pure page-geometry math shared by the Windows worker and the host. No imports: the worker has no sharp.

/**
 * Headful Chrome shrinks the visible window while it takes a screenshot whose clip or scale differs from the page's
 * own viewport, so the human sees a flash. A plain viewport screenshot does not. The worker takes that one and the
 * host derives the CSS-pixel screenshot and the element screenshot from it (see web-capture.ts).
 */

/** What the worker measured on the page at capture time. */
export interface PageGeometry {
  /** window.devicePixelRatio. */
  dpr: number;
  scrollX: number;
  scrollY: number;
  /** window.innerWidth and innerHeight: the CSS-pixel size of the viewport screenshot. */
  innerWidth: number;
  innerHeight: number;
}
/** An element's bounding box in CSS pixels of the viewport, as Playwright's boundingBox reports it. */
export interface CssBox { x: number; y: number; width: number; height: number }
interface ImageSize { width: number; height: number }
export interface PageFrame extends ImageSize { id: string }

/** Size of the PNG shown to the agent. Round each edge once; never upscale. */
export function pageImageSize({ width, height }: ImageSize): ImageSize {
  const scale = Math.min(1, 1280 / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** Convert a shown PNG point to Playwright's viewport CSS space, not document or screen space. */
export function framePoint({ x, y }: { x: number; y: number }, image: ImageSize, viewport: PageGeometry) {
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= image.width || y >= image.height) return undefined;
  return { x: x / image.width * viewport.innerWidth, y: y / image.height * viewport.innerHeight };
}

/** A rectangle of the plain screenshot in its own (device) pixels. */
export interface PixelRect { left: number; top: number; width: number; height: number }

/** How a plain viewport screenshot becomes the wanted image on the host: scaled to CSS pixels (`css`), or cut to an element's `box`. */
export interface Derive { geometry: PageGeometry; box?: CssBox; css?: true }

/** Whether the plain screenshot's pixels are device pixels of the viewport; false when Chrome shot something else, such as a zoomed page. */
export function matchesViewport(image: { width: number; height: number }, geometry: PageGeometry): boolean {
  return Math.abs(image.width - geometry.innerWidth * geometry.dpr) <= 1 && Math.abs(image.height - geometry.innerHeight * geometry.dpr) <= 1;
}

/**
 * Where an element lies in the plain screenshot, or undefined when it is not wholly inside it. Chrome's own element
 * screenshot covers the integer CSS rectangle around the box in page coordinates, which is what this reproduces.
 */
export function elementRect(box: CssBox, geometry: PageGeometry, image: { width: number; height: number }): PixelRect | undefined {
  const { dpr, scrollX, scrollY } = geometry;
  const left = Math.floor(box.x + scrollX), top = Math.floor(box.y + scrollY);
  const right = Math.ceil(box.x + scrollX + box.width), bottom = Math.ceil(box.y + scrollY + box.height);
  const rect = { left: Math.round((left - scrollX) * dpr), top: Math.round((top - scrollY) * dpr), width: Math.round((right - left) * dpr), height: Math.round((bottom - top) * dpr) };
  if (rect.width < 1 || rect.height < 1 || rect.left < 0 || rect.top < 0 || rect.left + rect.width > image.width || rect.top + rect.height > image.height) return undefined;
  return rect;
}
