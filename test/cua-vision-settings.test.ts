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
