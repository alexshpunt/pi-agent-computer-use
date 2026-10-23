import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { getToolExecution, PiIntegrationTest, testArtifactsDir } from "pi-coding-agent-test";
import { expect, test } from "vitest";

test("real Pi mirrors native provider image bytes and traces nested and captured-only calls", async () => {
  await mkdir(".tmp", { recursive: true });
  const cwd = await mkdtemp(path.resolve(".tmp", "vision-contract-"));
  const programs = [
    { id: "program", name: "codemode", args: { code: `
const view = await tools.computer_sample_open({});
image(view.image); text(view.text);
` } },
    { id: "captured-only", name: "codemode", args: { code: `
await tools.computer_sample_observe({});
text("Capture deliberately not forwarded.");
` } },
    { id: "failed", name: "codemode", args: { code: "await tools.computer_sample_fail({});" } },
    { id: "ide-form", name: "codemode", args: { code: `
await tools.read({ path: "computer:window/fixture" });
await tools.read({ path: "note.txt" });
text("IDE-form computer read and an ordinary read.");
` } },
    { id: "close", name: "computer_sample_close", args: {} },
  ];
  const bodies: Record<string, unknown>[] = [];
  const provider = createServer(async (request, response) => {
    let input = "";
    for await (const chunk of request) input += chunk;
    bodies.push(JSON.parse(input));
    const call = programs[bodies.length - 1];
    const delta = call
      ? { tool_calls: [{ index: 0, id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } }] }
      : { content: "The debug trace is complete." };
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write("data: " + JSON.stringify({ id: "fixture-" + bodies.length, object: "chat.completion.chunk", model: "fixture",
      choices: [{ index: 0, delta, finish_reason: call ? "tool_calls" : "stop" }] }) + "\n\n");
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture port.");
  try {
    const run = await new PiIntegrationTest({
      testName: "vision-debug-native-provider", artifactsDir: testArtifactsDir(import.meta.filename), cwd,
      extensions: [path.resolve("test/fixtures/vision-extension.ts")],
      tools: ["codemode", "read", "computer_sample_open", "computer_sample_observe", "computer_sample_fail", "computer_sample_close"],
      providerMode: "user", model: "vision-loopback/fixture", rawMode: true,
      environment: { VISION_TEST_PROVIDER: `http://127.0.0.1:${address.port}/v1` },
      isolateUserResources: true,
    }).run("Exercise only the synthetic image tools through Codemode, including captured-only output and a refusal.");
    const state = JSON.parse(await readFile(path.join(cwd, "vision-trace.json"), "utf8"));
    await mkdir(run.artifacts.directory, { recursive: true });
    await writeFile(path.join(run.artifacts.directory, "vision-trace.json"), JSON.stringify(state, null, 2));
    await writeFile(path.join(run.artifacts.directory, "provider-bodies.json"), JSON.stringify(bodies, null, 2));
    expect(state.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "program/1", parentId: "program", tool: "computer_sample_open", status: "observed" }),
      expect.objectContaining({ id: "captured-only/1", parentId: "captured-only", tool: "computer_sample_observe" }),
      expect.objectContaining({ id: "failed/1", isError: true }),
      expect.objectContaining({ id: "ide-form/1", parentId: "ide-form", tool: "read", status: "observed" }),
    ]));
    expect(state.actions.map((action: { id: string }) => action.id)).not.toContain("ide-form/2");
    expect(state.captures).toHaveLength(3);
    expect(state.frames.length).toBeGreaterThan(0);
    expect(state.frames.every((frame: { finalDelivery: string }) => frame.finalDelivery === "unconfirmed")).toBe(true);
    expect(state.requests).toHaveLength(bodies.length);
    const encoded = JSON.stringify(bodies.at(-1)).match(/data:image\/png;base64,([A-Za-z0-9+/=]+)/)?.[1];
    expect(encoded).toBeDefined();
    expect(state.frames.at(-1).hash).toBe(createHash("sha256").update(Buffer.from(encoded!, "base64")).digest("hex"));
    expect(state.requests.at(-1).responseStatus).toBe(200);
    expect(getToolExecution(run, "failed").isError).toBe(true);
    const url = await readFile(path.join(cwd, "vision-url.txt"), "utf8");
    await expect(fetch(url)).rejects.toThrow();
  } finally {
    await new Promise<void>(resolve => { provider.close(() => resolve()); provider.closeAllConnections(); });
    await rm(cwd, { recursive: true, force: true });
  }
});
