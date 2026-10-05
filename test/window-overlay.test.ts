import { expect, test, vi } from "vitest";
import { WindowOverlay, type OverlayPeer } from "../src/window-overlay.ts";

const frame = { target: { pid: 42, window_id: 123 }, identity: `PiComputerUse.${"a".repeat(32)}:42:7`,
  bounds: { x: -100, y: 20, width: 900, height: 600 } };
function peer(): OverlayPeer {
  return { send: vi.fn(async command => ({ status: command.kind === "flash" ? "shown" : "hidden", generation: command.generation })),
    close: vi.fn(async () => {}) };
}

test("registration and clearing an unused frame never start a native helper", async () => {
  const start = vi.fn(async () => peer()); const overlay = new WindowOverlay(start);
  await overlay.clear(); await overlay.close(); expect(start).not.toHaveBeenCalled();
});

test("a flash uses the exact lifetime, physical bounds and a two second expiry", async () => {
  const native = peer(); const start = vi.fn(async () => native); const overlay = new WindowOverlay(start);
  expect(await overlay.flash(frame)).toMatchObject({ status: "shown" });
  expect(native.send).toHaveBeenCalledWith({ kind: "flash", generation: 1, ...frame, duration_ms: 2000 });
  expect(await overlay.flash({ ...frame, target: { pid: 42, window_id: 456 } })).toMatchObject({ status: "shown" });
  expect(start).toHaveBeenCalledTimes(1);
  await overlay.close(); expect(native.close).toHaveBeenCalledTimes(1);
});

test("a cancelled read or mismatched lifetime cannot launch or flash", async () => {
  const start = vi.fn(async () => peer()); const overlay = new WindowOverlay(start);
  const aborted = new AbortController(); aborted.abort();
  expect(await overlay.flash(frame, aborted.signal)).toMatchObject({ status: "skipped" });
  expect(await overlay.flash({ ...frame, identity: frame.identity.replace(":42:", ":99:") })).toMatchObject({ status: "skipped" });
  expect(await overlay.flash({ ...frame, bounds: { ...frame.bounds, width: NaN } })).toMatchObject({ status: "skipped" });
  expect(start).not.toHaveBeenCalled();
});

test("a permission clear while the helper starts suppresses the late flash", async () => {
  let ready!: (value: OverlayPeer) => void; const native = peer();
  const overlay = new WindowOverlay(() => new Promise(resolve => { ready = resolve; }));
  const showing = overlay.flash(frame); const clearing = overlay.clear(); await Promise.resolve(); ready(native);
  expect(await showing).toMatchObject({ status: "skipped" }); await clearing;
  expect(native.send).toHaveBeenCalledExactlyOnceWith({ kind: "hide", generation: 2 }); await overlay.close();
});

test("aborting an older read cannot hide a newer window flash", async () => {
  const native = peer(); const overlay = new WindowOverlay(async () => native); const abort = new AbortController();
  await overlay.flash(frame, abort.signal); await overlay.flash(frame); abort.abort();
  expect(vi.mocked(native.send).mock.calls.map(([command]) => command.kind)).toEqual(["flash", "flash"]);
  await overlay.close();
});

test("helper startup failure is reported without retrying a capture or claiming a frame", async () => {
  const start = vi.fn(async () => { throw new Error("native startup failed"); }); const overlay = new WindowOverlay(start);
  expect(await overlay.flash(frame)).toMatchObject({ status: "unavailable" });
  expect(await overlay.flash(frame)).toMatchObject({ status: "unavailable" });
  expect(start).toHaveBeenCalledTimes(1); await overlay.close();
});
