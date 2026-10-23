import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";
import { VisionTrace } from "../src/vision-trace.ts";

test("annotated captures retain exact raw bytes privately without consuming another boundary card", async () => {
  const raw = await readFile(new URL("./fixtures/cua-zoom.jpg", import.meta.url));
  const marked = Buffer.from("separate marked test bytes");
  const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  const trace = new VisionTrace("hints");
  trace.retainOriginal({ type: "image", mimeType: "image/jpeg", data: raw.toString("base64") });
  trace.startAction("hints", "computer_observe", {});
  trace.finishAction("hints", [{ type: "image", mimeType: "image/png", data: marked.toString("base64") }],
    { status: "observed", agent_image: { annotation: { raw: { hash: hash(raw) }, labels: [{ hint: "1:a" }] }, output: { hash: hash(marked) } } }, false);
  trace.observePayload({ input: [{ type: "input_image", image_url: `data:image/png;base64,${marked.toString("base64")}` }] }, { provider: "test", api: "test", model: "test" });
  const state = trace.snapshot();
  expect(state.frames).toHaveLength(1);
  expect(state.frames[0]).toMatchObject({ original: "available", originalHash: hash(raw) });
  expect(trace.asset(hash(raw))?.equals(raw)).toBe(true);
  expect(JSON.stringify(state)).not.toContain(raw.toString("base64"));
  trace.reset("another"); expect(trace.asset(hash(raw))).toBeUndefined();
});

test("the common source envelope reaches capture and provider-preview metadata without changing image bytes", async () => {
  const bytes = await readFile(new URL("./fixtures/cua-zoom.jpg", import.meta.url));
  const data = bytes.toString("base64"); const hash = createHash("sha256").update(bytes).digest("hex");
  const source = { kind: "display", domain: "windows-host", identity: { display_id: "primary" }, capabilities: { input: "none" },
    image: { scope: "primary_display", coordinate_space: "display_image_pixels", dimensions: { width: 499, height: 333 }, original_dimensions: { width: 3840, height: 2560 } } };
  const trace = new VisionTrace("source-proof");
  trace.startAction("capture", "computer_observe", { display: "primary" });
  trace.finishAction("capture", [{ type: "image", data, mimeType: "image/jpeg" }], { status: "observed", source, image: { type: "image", data, mimeType: "image/jpeg" } }, false);
  trace.observePayload({ input: [{ type: "input_image", image_url: `data:image/jpeg;base64,${data}` }] }, { provider: "test", api: "test", model: "test" });
  expect(trace.snapshot().captures[0].source).toMatchObject({ observation: source });
  expect(trace.snapshot().frames[0].source).toMatchObject({ observation: source });
  expect(trace.snapshot().actions[0].adapterStructure).not.toHaveProperty("image");
  expect(JSON.stringify(trace.snapshot().actions[0].adapterStructure)).not.toContain(data);
  expect(trace.asset(hash)?.equals(bytes)).toBe(true);
});

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
