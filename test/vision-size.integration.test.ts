import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { getToolExecution, PiIntegrationTest, testArtifactsDir } from "pi-coding-agent-test";
import { expect, test } from "vitest";
import sharp from "sharp";

// Crosses the actual Pi loader, tools, nested Codemode calls and native provider payload hook.
test("real Pi forwards physically resized images with frozen versions and source-mapped click input", async () => {
  await mkdir(".tmp", { recursive: true });
  const cwd = await mkdtemp(path.resolve(".tmp", "vision-size-contract-"));
  const calls = [
    { id: "open", name: "browser_open", args: { url: "https://example.test" } },
    { id: "capture", name: "codemode", args: { code: 'const v=await tools.browser_observe({});image(v.image);' } },
    { id: "click", name: "browser_act", args: { click: { x: 200, y: 100 }, observe: false } },
    { id: "close", name: "browser_close", args: {} },
  ];
  const bodies: unknown[] = [];
  const provider = createServer(async (request, response) => {
    let input = ""; for await (const chunk of request) input += chunk;
    bodies.push(JSON.parse(input));
    // Change settings after the default 500px capture, before the next capture.
    if (bodies.length === 2) {
      const url = new URL("settings", await readFile(path.join(cwd, "viewer-url.txt"), "utf8"));
      const changed = await fetch(url, { method: "POST", headers: { Origin: url.origin, "Content-Type": "application/json" },
        body: JSON.stringify({ kernel: "mitchell", maxLongEdge: 800, scale: 0.5 }) });
      if (changed.status !== 200) throw new Error("Settings refused.");
    }
    const call = calls[bodies.length - 1];
    const delta = call ? { tool_calls: [{ index: 0, id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } }] }
      : { content: "Pixel-size contract complete." };
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write("data: " + JSON.stringify({ id: "size-" + bodies.length, object: "chat.completion.chunk", model: "fixture",
      choices: [{ index: 0, delta, finish_reason: call ? "tool_calls" : "stop" }] }) + "\n\n");
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address(); if (!address || typeof address === "string") throw new Error("No port.");
  try {
    const run = await new PiIntegrationTest({ testName: "vision-size-native-provider", artifactsDir: testArtifactsDir(import.meta.filename), cwd,
      extensions: [path.resolve("test/fixtures/vision-size-extension.ts")], tools: ["browser_open", "browser_observe", "browser_act", "browser_close", "codemode"],
      isolateUserResources: true, providerMode: "user", model: "vision-size/fixture",
      environment: { VISION_TEST_PROVIDER: "http://127.0.0.1:" + address.port + "/v1" },
    }).run("Use only the synthetic owned-browser fixture; verify image resizing through actual tools.");
    expect(getToolExecution(run, "click").isError).toBe(false);
    const sourceInput = JSON.parse((await readFile(path.join(cwd, "inputs.jsonl"), "utf8")).trim());
    expect(sourceInput).toMatchObject({ action: "click", x: 600, y: 300 });
    const state = JSON.parse(await readFile(path.join(cwd, "trace.json"), "utf8"));
    expect(state.captures.map((frame: { width: number }) => frame.width)).toEqual([500, 400]);
    expect(state.captures[0].configuration.effective.configuration).toMatchObject({ kernel: "mks2021", maxLongEdge: 500, scale: 1 });
    expect(state.captures.map((frame: { configuration: { effective: { configuration: { version: number } } } }) => frame.configuration.effective.configuration.version)).toEqual([0, 1]);
    expect(state.captures.every((frame: { original: string }) => frame.original === "available")).toBe(true);
    const encoded = JSON.stringify(bodies.at(-1)).match(/data:image\/png;base64,([A-Za-z0-9+/=]+)/g) ?? [];
    const dimensions = await Promise.all(encoded.map(value => sharp(Buffer.from(value.split(",")[1], "base64")).metadata()));
    expect(dimensions.map(info => info.width)).toContain(400);
    expect(dimensions.map(info => info.width)).not.toContain(1200);
    await expect(fetch(await readFile(path.join(cwd, "viewer-url.txt"), "utf8"))).rejects.toThrow();
  } finally {
    await new Promise<void>(resolve => { provider.close(() => resolve()); provider.closeAllConnections(); });
    await rm(cwd, { recursive: true, force: true });
  }
});
