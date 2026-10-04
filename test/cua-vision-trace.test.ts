import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";
import { VisionTrace } from "../src/vision-trace.ts";

test("native JPEG preview keeps exact bytes, matching dimensions and its zoom coordinate domain", async () => {
  const bytes = await readFile(new URL("./fixtures/cua-zoom.jpg", import.meta.url));
  const data = bytes.toString("base64"); const hash = createHash("sha256").update(bytes).digest("hex");
  const trace = new VisionTrace("cua-zoom");
  const details = { status: "observed", tab: 1, agent_image: { route: "cua_fresh_zoom", coordinate_space: "zoom_image_pixels",
    configuration: { kernel: "lanczos3", maxWidth: 500 }, output: { hash, width: 152, height: 120 }, native: { width: 152, height: 120 } } };
  trace.startAction("zoom", "browser_observe", { zoom: { x: 24, y: 165, width: 41, height: 32 } });
  trace.finishAction("zoom", [{ type: "image", data, mimeType: "image/jpeg" }], details, false);
  trace.observePayload({ input: [{ type: "input_image", image_url: `data:image/jpeg;base64,${data}` }] }, { provider: "test", api: "test", model: "test" });
  expect(trace.snapshot().frames[0]).toMatchObject({ width: 152, height: 120, original: "unavailable", source: { route: "cua_fresh_zoom", coordinate_space: "zoom_image_pixels" } });
  expect(trace.asset(hash)?.equals(bytes)).toBe(true); expect(trace.assetMime(hash)).toBe("image/jpeg");
});
