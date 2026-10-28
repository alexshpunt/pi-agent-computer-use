import { expect, test, vi } from "vitest";
import { NativeVisuals, VisualSettings, notifyHighlight } from "../src/native-visuals.ts";

const frame = { target: { window_id: 101, pid: 42 }, identity: `PiComputerUse.${"a".repeat(32)}:42:1`,
  bounds: { x: -100, y: 20, width: 800, height: 600 } };
const tick = async () => { for (let n = 0; n < 8; n++) await Promise.resolve(); };

test("presentation returns immediately while native admission is pending, with only the newest pending image retained", async () => {
  const sent: { name: string; args: Record<string, unknown> }[] = [];
  let release!: () => void;
  const visuals = new NativeVisuals(async (name, args) => { sent.push({ name, args }); await new Promise<void>(r => { release = r; }); return true; });
  expect(await visuals.flash(frame)).toMatchObject({ status: "queued" });
  await tick();
  for (let n = 1; n <= 100; n++) await visuals.flash({ ...frame, mark: { kind: "action", point: { x: n, y: 50 } } });
  expect(sent).toHaveLength(1);
  release(); await tick();
  expect(sent).toHaveLength(2);
  expect(sent[1].args).toMatchObject({ generation: 101, point: { x: 100, y: 50 } });
  release(); await tick(); visuals.close();
});

test("previews contain the supplied output image and validated physical source, never a new capture", async () => {
  const send = vi.fn(async (_name: string, _args: Record<string, unknown>) => true); const visuals = new NativeVisuals(send);
  const image = { type: "image" as const, mimeType: "image/png", data: "aGVsbG8=" };
  await notifyHighlight(visuals.flash, { ...frame, image }); await tick();
  expect(send).toHaveBeenCalledExactlyOnceWith("present_agent_activity", {
    generation: 1, kind: "overview", source: { window_id: 101, pid: 42, identity: frame.identity, bounds: frame.bounds },
    image: { data: image.data, mime_type: image.mimeType },
  });
  visuals.close();
});

test("invalid or out-of-source geometry is cleared without sending image content", async () => {
  const send = vi.fn(async (_name: string, _args: Record<string, unknown>) => true); const visuals = new NativeVisuals(send);
  const result = await notifyHighlight(visuals.flash, { ...frame, identity: frame.identity.replace(":42:", ":99:") });
  await tick();
  expect(result?.status).toBe("unavailable");
  expect(send.mock.calls).toEqual([["present_agent_activity", { kind: "clear", generation: 1 }]]);
  visuals.close();
});

test("off discards queued images and old cancellation cannot clear a newer event", async () => {
  const send = vi.fn(async (_name: string, _args: Record<string, unknown>) => true); const settings = new VisualSettings(); const visuals = new NativeVisuals(send, settings);
  const abort = new AbortController();
  await visuals.flash(frame, abort.signal); await tick();
  await visuals.flash(frame); await tick();
  abort.abort(); await tick();
  expect(send).toHaveBeenCalledTimes(2);
  settings.update({ preset: "off" }); await tick();
  expect(send.mock.calls.at(-1)).toEqual(["set_agent_visuals", expect.objectContaining({ preset: "off" })]);
  const count = send.mock.calls.length;
  expect(await visuals.flash(frame)).toMatchObject({ status: "skipped" });
  await tick(); expect(send).toHaveBeenCalledTimes(count); visuals.close();
});

test("selected-display regions retain their physical monitor origin", async () => {
  const send = vi.fn(async (_name: string, _args: Record<string, unknown>) => true); const visuals = new NativeVisuals(send);
  await visuals.flash({ display: "DISPLAY2", bounds: { x: -1920, y: 0, width: 1920, height: 1080 }, mark: {
    kind: "detail", region: { x: -1900, y: 40, width: 200, height: 100 },
  } }); await tick();
  expect(send.mock.calls[0][1]).toMatchObject({ source: { display: "DISPLAY2", bounds: { x: -1920, y: 0 } }, region: { x: -1900, y: 40 } });
  visuals.close();
});

test("restoring a branch resets unrelated preferences and rejects prototype keys", () => {
  const settings = new VisualSettings();
  settings.update({ keyboard: false, quality: "high" });
  expect(settings.restore({ preset: "subtle" })).toMatchObject({ keyboard: true, quality: "balanced", previews: false });
  const before = settings.current();
  expect(() => settings.update(JSON.parse('{"constructor":false}'))).toThrow();
  expect(settings.current()).toEqual(before);
});
test("settings validate before mutation and unavailable native presentation does not throw into operations", async () => {
  const settings = new VisualSettings();
  expect(() => settings.update({ opacity: NaN })).toThrow();
  expect(settings.current().opacity).toBe(0.8);
  const visuals = new NativeVisuals(async () => { throw new Error("not available"); }, settings);
  expect(await visuals.flash(frame)).toMatchObject({ status: "queued" }); await tick();
  expect(await visuals.flash(frame)).toMatchObject({ status: "unavailable" }); visuals.close();
});
