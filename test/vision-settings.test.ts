import { runInNewContext } from "node:vm";
import { visionScript } from "../src/vision-panel.ts";
import { expect, test } from "vitest";
import { VisionImages } from "../src/vision-images.ts";
import { VisionTrace } from "../src/vision-trace.ts";
import { startVisionServer } from "../src/vision-server.ts";

test("panel polling does not overwrite an unsubmitted slider or long-edge edit", async () => {
  const nodes = new Map<string, { value: string; textContent: string; handlers: Map<string, (event?: unknown) => Promise<void> | void>; addEventListener(name: string, handler: (event?: unknown) => Promise<void> | void): void }>();
  const document = { getElementById(id: string) {
    if (!nodes.has(id)) nodes.set(id, { value: "", textContent: "", handlers: new Map(), addEventListener(name, handler) { this.handlers.set(name, handler); } });
    return nodes.get(id)!;
  } };
  let posted: unknown;
  const fetch = async (_url: string, options: { body: string }) => {
    posted = JSON.parse(options.body);
    return { ok: true, json: async () => ({ ...(posted as object), version: 1 }) };
  };
  const panel = runInNewContext(visionScript.replace(/poll\(\);\s*$/, "") + "\n({setupSettings,renderSettings,settingsDraft});", { document, fetch });
  panel.setupSettings();
  const initial = { kernel: "lanczos3", maxLongEdge: 800, scale: 1, version: 0 };
  panel.renderSettings(initial);
  document.getElementById("scale").value = "0.5";
  document.getElementById("scale").handlers.get("input")!();
  document.getElementById("long-edge").value = "1600";
  panel.renderSettings(initial);
  expect(panel.settingsDraft()).toEqual({ kernel: "lanczos3", maxLongEdge: 1600, scale: 0.5 });
  document.getElementById("scale-number").value = "0.625";
  document.getElementById("scale-number").handlers.get("input")!();
  expect(document.getElementById("scale").value).toBe("0.625");
  expect(panel.settingsDraft().scale).toBe(0.625);
  await document.getElementById("image-settings").handlers.get("submit")!({ preventDefault() {} });
  expect(posted).toEqual({ kernel: "lanczos3", maxLongEdge: 1600, scale: 0.625 });
  expect(document.getElementById("settings-status").textContent).toContain("Applied v1");
});
// The settings boundary must not become a policy or arbitrary execution endpoint.
test("session settings require same-origin bounded JSON and reject invalid tuples atomically", async () => {
  const images = new VisionImages(); const trace = new VisionTrace("settings");
  const server = await startVisionServer(trace, images);
  const settings = new URL("settings", server.url);
  const body = { kernel: "mitchell", maxLongEdge: 1600, scale: 0.5 };
  const post = (value: unknown, headers = { Origin: settings.origin, "Content-Type": "application/json" }) => fetch(settings, { method: "POST", headers, body: JSON.stringify(value) });
  try {
    expect((await post(body, { Origin: "https://foreign.test", "Content-Type": "application/json" })).status).toBe(403);
    expect((await fetch(settings, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).status).toBe(403);
    expect((await post({ ...body, mode: "yolo" })).status).toBe(400);
    expect((await post({ ...body, scale: 0 })).status).toBe(400);
    expect((await post("x".repeat(1200))).status).toBe(413);
    expect(images.settings().version).toBe(0);
    expect(await (await post(body)).json()).toMatchObject({ ...body, version: 1 });
    expect((await (await fetch(new URL("state", server.url))).json()).imageSettings).toMatchObject({ ...body, version: 1 });
    expect((await fetch(new URL("state", server.url), { method: "POST" })).status).toBe(405);
    expect((await fetch(new URL("/settings", server.url), { method: "POST" })).status).toBe(404);
  } finally { await server.close(); }
});
