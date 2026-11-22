// Types for layout.js, for the unit tests; the page itself is plain JavaScript.
export function gridLayout<K>(windows: { key: K; width: number; height: number }[], area: { x: number; y: number; width: number; height: number },
  options?: { caption?: number; gap?: number }): Map<K, { x: number; y: number; width: number; height: number; scale: number }>;
