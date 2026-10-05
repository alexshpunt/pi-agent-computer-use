import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";
import { CuaImageSettings } from "../src/cua-image-settings.ts";
import { startVisionServer } from "../src/vision-server.ts";
import { VisionTrace } from "../src/vision-trace.ts";

// Native controls must not imply that a second image engine still runs.
test("native settings freeze captures, reject unsupported kernels and reset without originals", () => {
  const images = new CuaImageSettings(); const first = images.settings();
  expect(first).toMatchObject({ kernel: "lanczos3", maxLongEdge: 500, scale: 1, version: 0 });
  expect(images.update({ kernel: "lanczos3", maxLongEdge: 800, scale: 0.625 })).toMatchObject({ version: 1, scale: 0.625 });
  expect(first.scale).toBe(1);
  for (const input of [{ kernel: "mks2021", maxLongEdge: 500, scale: 1 }, { kernel: "lanczos3", maxLongEdge: 500, scale: 0 }, { kernel: "lanczos3", maxLongEdge: 500, scale: 1, mode: "yolo" }])
    expect(() => images.update(input)).toThrow();
  expect(images.settings().version).toBe(1);
  images.reset(); expect(images.settings()).toEqual(first);
});

test("the native debug server reports the active route and refuses the retired trial and kernel controls", async () => {
  const images = new CuaImageSettings(); const server = await startVisionServer(new VisionTrace("native"), images);
  const settings = new URL("settings", server.url);
  const post = (value: unknown) => fetch(settings, { method: "POST", headers: { Origin: settings.origin, "Content-Type": "application/json" }, body: JSON.stringify(value) });
  try {
    expect((await fetch(new URL("trial", server.url))).status).toBe(410);
    expect((await post({ kernel: "mks2021", maxLongEdge: 500, scale: 1 })).status).toBe(400);
    expect(await (await post({ kernel: "lanczos3", maxLongEdge: 800, scale: 0.625 })).json()).toMatchObject({ version: 1, route: "cua_native" });
    expect((await (await fetch(new URL("state", server.url))).json()).imageSettings).toMatchObject({ route: "cua_native", kernel: "lanczos3", maxLongEdge: 800, scale: 0.625 });
  } finally { await server.close(); }
});

test("concurrent native settings stay session-local and preserve a frame's captured configuration", async () => {
  const first = new CuaImageSettings(); const second = new CuaImageSettings();
  const trace = new VisionTrace("first"); const frozen = first.settings();
  const bytes = await readFile(new URL("./fixtures/cua-zoom.jpg", import.meta.url));
  trace.startAction("capture", "browser_observe", {});
  const a = await startVisionServer(trace, first);
  const b = await startVisionServer(new VisionTrace("second"), second);
  const post = (base: string, maxLongEdge: number, scale: number) => {
    const url = new URL("settings", base);
    return fetch(url, { method: "POST", headers: { Origin: url.origin, "Content-Type": "application/json" },
      body: JSON.stringify({ kernel: "lanczos3", maxLongEdge, scale }) }).then(response => response.json());
  };
  try {
    const replies = await Promise.all([post(a.url, 800, 0.5), post(a.url, 600, 0.75)]);
    expect(replies.map(value => value.version).sort()).toEqual([1, 2]);
    const last = replies.find(value => value.version === 2);
    expect(first.settings()).toEqual(last);
    expect(second.settings()).toMatchObject({ maxLongEdge: 500, scale: 1, version: 0 });
    trace.finishAction("capture", [{ type: "image", data: bytes.toString("base64"), mimeType: "image/jpeg" }],
      { status: "observed", agent_image: { configuration: frozen } }, false);
    const state = await (await fetch(new URL("state", a.url))).json();
    expect(state.imageSettings).toEqual(last);
    expect(state.captures[0].configuration.effective.configuration).toEqual(frozen);
    const image = await fetch(new URL(`images/${state.captures[0].hash}`, a.url));
    expect(Buffer.from(await image.arrayBuffer()).equals(bytes)).toBe(true);
    const foreign = new URL(a.url); foreign.host = new URL(b.url).host;
    expect((await fetch(new URL("settings", foreign))).status).toBe(404);
    const before = structuredClone(state.captures);
    await post(a.url, 4096, 1);
    expect((await (await fetch(new URL("state", a.url))).json()).captures).toEqual(before);
    first.reset();
    expect(first.settings()).toEqual(frozen);
    expect(second.settings()).toEqual(frozen);
  } finally { await Promise.all([a.close(), b.close()]); }
});

test("unsafe or invalid settings writes cannot change any part of the active tuple", async () => {
  const images = new CuaImageSettings(); const server = await startVisionServer(new VisionTrace("writes"), images);
  const url = new URL("settings", server.url); const initial = images.settings();
  const valid = JSON.stringify({ kernel: "lanczos3", maxLongEdge: 800, scale: 0.5 });
  const json = { Origin: url.origin, "Content-Type": "application/json" };
  try {
    for (const [headers, body, status] of [
      [{ "Content-Type": "application/json" }, valid, 403],
      [{ ...json, Origin: "https://foreign.example" }, valid, 403],
      [{ ...json, "Content-Type": "text/plain" }, valid, 403],
      [json, valid.replace("0.5", "0"), 400],
      [json, valid.replace("800", "800.5"), 400],
      [json, valid.slice(0, -1) + ',"mode":"yolo"}', 400],
      [json, "{", 400],
      [json, " ".repeat(1025), 413],
    ] as const) {
      expect((await fetch(url, { method: "POST", headers, body })).status).toBe(status);
      expect(images.settings()).toEqual(initial);
    }
    expect((await fetch(new URL("state", server.url), { method: "POST", headers: json, body: valid })).status).toBe(405);
    expect(images.settings()).toEqual(initial);
  } finally { await server.close(); }
});