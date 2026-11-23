import type { InputCommand } from "./complete-input.ts";
import type { ScreenRect, WindowImageMapping } from "./highlight-geometry.ts";
import type { ScreenZone } from "./input-lease.ts";

/** A point in an observation's window image pixels. */
export interface ImagePoint { x: number; y: number }

/** Every pointer position one input command names in window image pixels: its point, drag ends, path, held pointer steps and timeline points. */
export function commandPoints(command: InputCommand): ImagePoint[] {
  const points: ImagePoint[] = [];
  const add = (x: unknown, y: unknown) => { if (typeof x === "number" && typeof y === "number") points.push({ x, y }); };
  add(command.x, command.y);
  add(command.from_x, command.from_y);
  add(command.to_x, command.to_y);
  for (const point of command.via ?? []) add(point.x, point.y);
  for (const pointer of command.actions ?? []) points.push(...commandPoints(pointer as InputCommand));
  for (const event of command.events ?? []) if (event.type !== "move_relative") add(event.x, event.y);
  return points;
}

/**
 * Where a window image point lies on the screen: the window's observed bounds, plus CUA's proven inset and scale when
 * the observation has them, otherwise the image's uniform scale over the window's width.
 */
export function screenPoint(point: ImagePoint, bounds: ScreenRect, imageWidth: number, mapping?: WindowImageMapping): ImagePoint {
  if (mapping) return { x: bounds.x + mapping.offsetX + point.x * mapping.scale, y: bounds.y + mapping.offsetY + point.y * mapping.scale };
  const scale = bounds.width / imageWidth;
  return { x: bounds.x + point.x * scale, y: bounds.y + point.y * scale };
}

export function insideZone(point: ImagePoint, zone: ScreenZone): boolean {
  return point.x >= zone.x && point.y >= zone.y && point.x < zone.x + zone.width && point.y < zone.y + zone.height;
}

/**
 * The first screen point of a command that falls outside the zone, or undefined when all are inside. Element targets
 * count by the centre of their native frame; commands without a pointer position, such as keys, never fall outside.
 */
export function pointOutsideZone(command: InputCommand, zone: ScreenZone, observed: { bounds?: ScreenRect; width?: number; mapping?: WindowImageMapping; frames: Map<string, ScreenRect> }): ImagePoint | undefined {
  const frame = command.element_token ? observed.frames.get(command.element_token) : undefined;
  if (frame) {
    const centre = { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 };
    if (!insideZone(centre, zone)) return centre;
  }
  const points = commandPoints(command);
  if (!points.length || !observed.bounds || !observed.width) return undefined;
  for (const point of points) {
    const screen = screenPoint(point, observed.bounds, observed.width, observed.mapping);
    if (!insideZone(screen, zone)) return { x: Math.round(screen.x), y: Math.round(screen.y) };
  }
  return undefined;
}
