import { createHash } from "node:crypto";
import { request } from "node:http";
import { runInNewContext } from "node:vm";
import { visionScript } from "../src/vision-panel.ts";
import { createPanelDom } from "./fixtures/vision-panel-dom.ts";
import { expect, test } from "vitest";
import { VisionTrace } from "../src/vision-trace.ts";
import { startVisionServer } from "../src/vision-server.ts";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jC1kAAAAASUVORK5CYII=";
const image = { type: "image", data: png, mimeType: "image/png" };
const hash = createHash("sha256").update(Buffer.from(png, "base64")).digest("hex");
const payload = (count = 1) => ({ input: [{ role: "user", content: Array.from({ length: count }, () => ({ type: "input_image", image_url: `data:image/png;base64,${png}`, detail: "high" })) }], instructions: "not a UI tree" });

test("panel polling keeps expanded action rows and their text scroll position", () => {
  const { document, nodes } = createPanelDom();
  const trace = new VisionTrace("panel");
  trace.startAction("first", "browser_observe", {});
  trace.finishAction("first", [], { status: "observed" }, false);
  const render = runInNewContext(visionScript.replace(/poll\(\);\s*$/, "") + "\nrender;", { document });
  render(trace.snapshot());
  const first = nodes.get("actions")!.children[0];
  first.open = true;
  first.children[1].scrollTop = 80;
  trace.startAction("second", "browser_observe", {});
  render(trace.snapshot());
  expect(nodes.get("actions")!.children[1]).toBe(first);
  expect(first.open).toBe(true);
  expect(first.children[1].scrollTop).toBe(80);
});

test("links actual boundary image bytes to a nested action without claiming final delivery", () => {
  const trace = new VisionTrace("session-one");
  trace.startAction("program/1", "browser_observe", {}, "program");
  trace.finishAction("program/1", [image, { type: "text", text: "Visible UI" }], { status: "observed", tab: 1, elements: [{ hint: "a", name: "Button" }] }, false);
  expect(trace.snapshot().frames).toHaveLength(0);
  const boundary = payload();
  trace.observePayload(boundary, { provider: "openai-codex", api: "openai-codex-responses", model: "test" });
  trace.response(200);
  const state = trace.snapshot();
  expect(state.frames[0]).toMatchObject({ hash, actionId: "program/1", stage: "prepared", finalDelivery: "unconfirmed", width: 1, height: 1, detail: "high", original: "unavailable" });
  expect(state.actions[0]).toMatchObject({ id: "program/1", parentId: "program", status: "observed", isError: false });
  expect(state.requests[0]).toMatchObject({ responseStatus: 200, finalPayload: "unconfirmed" });
  expect(boundary).toEqual(payload());
  expect(trace.asset(hash)?.equals(Buffer.from(png, "base64"))).toBe(true);
});

test("retains only three displayed boundary images and never hides images in the effective context", () => {
  const trace = new VisionTrace("bounded");
  const body = payload(5);
  trace.observePayload(body, { provider: "openai", api: "openai-responses", model: "test" });
  expect(trace.snapshot().frames).toHaveLength(3);
  expect(trace.snapshot().requests[0]).toMatchObject({ imageCount: 5 });
  expect(body.input[0].content).toHaveLength(5);
  expect(trace.snapshot().limitations).toContain("The three-card viewer does not limit the model context.");
});

test("keeps captured-only images out of boundary history and reports action errors", () => {
  const trace = new VisionTrace("captured-only");
  trace.startAction("program/1", "browser_observe", {}, "program");
  trace.finishAction("program/1", [image], { status: "observed" }, false);
  trace.startAction("program/2", "browser_act", { click: "disabled" }, "program");
  trace.finishAction("program/2", [{ type: "text", text: "Observed element is disabled." }], undefined, true);
  trace.observePayload({ input: [{ type: "function_call_output", output: "Only text was forwarded" }] }, { provider: "test", api: "test", model: "test" });
  expect(trace.snapshot().frames).toHaveLength(0);
  expect(trace.snapshot().captures[0]).toMatchObject({ hash, stage: "captured", finalDelivery: "unconfirmed" });
  expect(trace.snapshot().actions[1]).toMatchObject({ isError: true, text: "Observed element is disabled." });
  expect(trace.snapshot().requests[0].texts[0].text).toBe("Only text was forwarded");
});

test("does not fetch remote images and isolates an old session on reset", () => {
  const trace = new VisionTrace("first");
  trace.observePayload(payload(), { provider: "test", api: "test", model: "test" });
  trace.reset("second");
  expect(trace.snapshot()).toMatchObject({ sessionId: "second", frames: [], captures: [], actions: [], requests: [] });
  expect(trace.asset(hash)).toBeUndefined();
  trace.observePayload({ messages: [{ content: [{ type: "image_url", image_url: { url: "https://private.example/image" } }] }] }, { provider: "test", api: "test", model: "test" });
  expect(trace.snapshot().frames).toHaveLength(0);
  expect(trace.snapshot().requests[0]).toMatchObject({ imageCount: 1, unavailableImages: 1 });
});

test("does not invent a unique source for identical captures and retains actual tool text", () => {
  const trace = new VisionTrace("ambiguous");
  for (const id of ["first", "captured-only"]) {
    trace.startAction(id, "browser_observe", {});
    trace.finishAction(id, [image], { status: "observed" }, false);
  }
  const block = { type: "input_image", image_url: `data:image/png;base64,${png}` };
  trace.observePayload({ messages: [{ role: "tool", content: "Actual forwarded structure" }], input: [{ content: [block, block] }] }, { provider: "test", api: "test", model: "test" });
  const state = trace.snapshot();
  expect(state.requests[0].imageCount).toBe(2);
  expect(state.requests[0].texts[0].text).toBe("Actual forwarded structure");
  expect(state.frames[0].actionId).toBeUndefined();
  expect(state.frames[0].matchingActionIds).toEqual(["first", "captured-only"]);
});

test("loopback viewer supports reconnect but rejects foreign routes, hosts and origins and closes", async () => {
  const trace = new VisionTrace("server-session");
  trace.observePayload(payload(), { provider: "test", api: "test", model: "test" });
  const server = await startVisionServer(trace);
  try {
    const page = await fetch(server.url);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(await page.text()).toContain("Final delivery is unconfirmed");
    const state = new URL("state", server.url);
    expect((await (await fetch(state)).json()).sessionId).toBe("server-session");
    expect((await (await fetch(state)).json()).frames[0].hash).toBe(hash);
    expect((await fetch(new URL(`images/${hash}`, server.url))).headers.get("content-type")).toBe("image/png");
    expect((await fetch(new URL("/state", server.url))).status).toBe(404);
    expect((await fetch(state, { headers: { Origin: "https://foreign.example" } })).status).toBe(403);
    const foreignHostStatus = await new Promise<number | undefined>((resolve, reject) => {
      const probe = request(state, { headers: { Host: "foreign.example" } }, response => {
        response.resume(); resolve(response.statusCode);
      });
      probe.on("error", reject); probe.end();
    });
    expect(foreignHostStatus).toBe(403);
    expect((await fetch(state, { method: "POST" })).status).toBe(405);
    trace.reset("new-session");
    expect((await (await fetch(state)).json()).frames).toHaveLength(0);
  } finally { await server.close(); }
  await expect(fetch(server.url)).rejects.toThrow();
  await server.close();
});
