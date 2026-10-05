import { expect, test, vi } from "vitest";
import { WindowHighlights } from "../src/window-highlights.ts";
import type { OverlayPeer } from "../src/window-overlay.ts";

const frame = { target: { pid: 42, window_id: 123 }, identity: `PiComputerUse.${"a".repeat(32)}:42:7`,
  bounds: { x: 10, y: 20, width: 900, height: 600 } };
function peer(): OverlayPeer {
  return { send: vi.fn(async command => ({ status: command.kind === "flash" ? "shown" : "hidden", generation: command.generation })), close: vi.fn(async () => {}) };
}

test("a new helper can start after confirmed close, never during shutdown", async () => {
  const first = peer(); const second = peer(); let stopped!: () => void;
  first.close = vi.fn(() => new Promise<void>(resolve => { stopped = resolve; }));
  const create = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
  const highlights = new WindowHighlights(create);
  await highlights.flash(frame); const closing = highlights.close();
  expect(await highlights.flash(frame)).toMatchObject({ status: "skipped" });
  await Promise.resolve(); stopped(); await closing;
  expect(await highlights.flash(frame)).toMatchObject({ status: "shown" });
  expect(create).toHaveBeenCalledTimes(2); await highlights.close();
});

test("uncertain helper shutdown is reported and cannot launch another helper", async () => {
  const native = peer(); native.close = vi.fn(async () => { throw new Error("unknown shutdown"); });
  const create = vi.fn(async () => native); const highlights = new WindowHighlights(create);
  await highlights.flash(frame); await expect(highlights.close()).rejects.toThrow("unknown shutdown");
  expect(await highlights.flash(frame)).toMatchObject({ status: "skipped" });
  expect(create).toHaveBeenCalledTimes(1);
});

test("permission clear and unused close do not start a helper", async () => {
  const create = vi.fn(async () => peer()); const highlights = new WindowHighlights(create);
  await highlights.clear(); await highlights.close(); expect(create).not.toHaveBeenCalled();
});
