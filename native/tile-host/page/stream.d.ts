// Types for stream.js, for the unit tests; the page itself is plain JavaScript.
export interface Rect { x: number; y: number; width: number; height: number }
export interface StreamWindow { id: string; title: string; app: string; pid: number; bounds: Rect; state: string; kind: string; focused: boolean; onScreen: boolean; z: number }
export function codecFromAnnexB(bytes: Uint8Array): string | undefined;
export function parseFrame(buffer: ArrayBuffer): { header: Record<string, unknown>; payload: Uint8Array };
export function tileWindows<T extends StreamWindow>(windows: T[]): T[];
export function stableOrder<T extends { id: string }>(windows: T[], order: Map<string, number>): T[];
export function maxDimensionFor(width: number, height: number, devicePixelRatio: number): number;
export function cursorInTile(point: { x: number; y: number } | undefined, bounds: Rect, scale: number): { x: number; y: number } | undefined;
