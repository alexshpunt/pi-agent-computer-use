// Types for layout.js, for the unit tests; the page itself is plain JavaScript.
export interface Area { x: number; y: number; width: number; height: number }
export interface TileRect { x: number; y: number; width: number; height: number; scale: number }
export interface LayoutWindow<K> { key: K; width: number; height: number }
export interface LayoutOptions { caption?: number; gap?: number }
export const MIN_SCALE: number;
export function splitRows<T extends { width: number; height: number }>(windows: T[], rows: number): T[][];
export function justifiedLayout<K>(windows: LayoutWindow<K>[], area: Area, options?: LayoutOptions & { minScale?: number }): { tiles: Map<K, TileRect>; scale: number; fill: number } | undefined;
export function layoutLayers<K>(windows: LayoutWindow<K>[], area: Area, options?: LayoutOptions & { minScale?: number }): { tiles: Map<K, TileRect>; scale: number }[];
