import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { getToolExecution, PiIntegrationTest, testArtifactsDir } from "pi-coding-agent-test";
import { expect, test } from "vitest";

test("real Pi retains all twelve images on the actual HTTP wire", async () => {
  await mkdir(".tmp/image-context", { recursive: true }); const cwd = await mkdtemp(path.resolve(".tmp/image-context/pi-"));
  const bodies: any[] = [];
  const provider = createServer(async (request, response) => {
    let input = ""; for await (const chunk of request) input += chunk; bodies.push(JSON.parse(input));
    const n = (bodies.length - 1) * 2;
    const delta = n < 12 ? { tool_calls: [{ index: 0, id: `frames-${n}`, type: "function", function: { name: "codemode",
      arguments: JSON.stringify({ code: `for (const n of [${n},${n + 1}]) { const v = await tools.computer_sample({n}); image(v.image); text("frame="+n); }` }) } }] }
      : { content: "Twelve frames verified" };
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write("data: " + JSON.stringify({ id: "fixture-" + bodies.length, object: "chat.completion.chunk", model: "fixture",
      choices: [{ index: 0, delta, finish_reason: n < 12 ? "tool_calls" : "stop" }] }) + "\n\n");
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve)); const address = provider.address();
  if (!address || typeof address === "string") throw Error("No fixture port");
  try {
    const run = await new PiIntegrationTest({ testName: "retained-image-wire", artifactsDir: testArtifactsDir(import.meta.filename), cwd,
      extensions: [path.resolve("test/fixtures/image-context-extension.ts")], tools: ["codemode", "computer_sample"],
      providerMode: "user", model: "image-loopback/fixture", environment: { VISION_TEST_PROVIDER: `http://127.0.0.1:${address.port}/v1` },
      isolateUserResources: true }).run("Return twelve synthetic frames in six Codemode batches. Keep every action's text, never capture real windows.");
    expect(bodies).toHaveLength(7);
    const wireImages = bodies.map(body => [...JSON.stringify(body).matchAll(/data:image\/(?:png|jpeg);base64,([A-Za-z0-9+/=]+)/g)].map(match => match[1]));
    expect(wireImages.map(images => images.length)).toEqual([0, 2, 4, 6, 8, 10, 12]);
    expect(new Set(wireImages.at(-1))).toHaveLength(12);
    expect(wireImages.at(-1)?.slice(0, 2)).toEqual(wireImages[1]);
    expect(new Set([...JSON.stringify(bodies.at(-1)).matchAll(/data:(image\/(?:png|jpeg));base64,/g)].map(m => m[1]))).toEqual(new Set(["image/png", "image/jpeg"]));
    expect(JSON.stringify(bodies.at(-1))).toContain(wireImages[1][0]);
    for (let n = 0; n < 12; n++) expect(JSON.stringify(bodies.at(-1))).toContain(`frame=${n}`);
    for (let n = 0; n < 12; n += 2) expect(getToolExecution(run, `frames-${n}`).isError).toBe(false);
    await writeFile(path.join(run.artifacts.directory, "provider-bodies.json"), JSON.stringify(bodies));
  } finally {
    await new Promise<void>(resolve => { provider.close(() => resolve()); provider.closeAllConnections(); });
    await rm(cwd, { recursive: true, force: true });
  }
});
