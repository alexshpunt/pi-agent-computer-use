import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { assistantMessage, getToolExecution, getToolExecutions, getToolResultText, PiIntegrationTest,
  testArtifactsDir, text, toolCall } from "pi-coding-agent-test";
import { expect, test } from "vitest";
import { readMachineSettings } from "../../src/config.ts";
import { IDE_EXTENSION, PI_COMMAND } from "../fixtures/pi-agent-ide.ts";
import { nestedCalls } from "../fixtures/standalone-computer.ts";

const root = path.resolve(import.meta.dirname, "../..");
const machine = process.env.LIVE_MACHINE;
const warmups = 5;
const samples = 10;
const maxLongEdge = Number(process.env.LIVE_READ_MAX_LONG_EDGE ?? 320);
const callId = "benchmark";

// Opt in to this probe alone. It opens Notepad in its own Windows session, not on the human's desktop.
test.skipIf(machine !== "local" && machine !== "zinpc")("real Pi: repeated Notepad window image reads", async () => {
  if (!Number.isSafeInteger(maxLongEdge) || maxLongEdge < 64 || maxLongEdge > 4096)
    throw new Error("LIVE_READ_MAX_LONG_EDGE must be an integer in 64..4096.");
  const cwd = await mkdtemp(path.join(tmpdir(), "pi-live-window-read-"));
  try {
    await configureMachine(cwd, machine!);
    const probe = process.env.LIVE_READ_TRACE_EXTENSION;
    const code = `
const opened = await tools.computer_open({ at: ${JSON.stringify(`computer:machine/${machine}`)}, isolated_session: true });
if (opened.outcome !== "delivered" || !opened.sandbox) throw Error("Open isolated session failed: " + JSON.stringify(opened));
try {
  const app = await tools.computer_open({ at: opened.sandbox, path: ${JSON.stringify("C:\\Windows\\System32\\notepad.exe")} });
  // Open can find the new window even when its initial observation failed. Benchmark only the explicit Reads.
  if (!app.window) throw Error("Open Notepad did not return a window: " + JSON.stringify(app));
  const timings = [];
  const views = ${JSON.stringify(["image", `capture:${JSON.stringify({ maxLongEdge })}`])};
  let latest;
  for (let i = 0; i < ${warmups + samples}; i++) {
    const start = Date.now();
    latest = await tools.read({ path: app.window, views });
    const elapsed = Date.now() - start;
    if (latest?.type !== "image" || latest.mimeType !== "image/png" || !latest.data)
      throw Error("Read " + (i + 1) + " did not deliver a PNG");
    if (i >= ${warmups}) timings.push(elapsed);
  }
  text("READ_TIMINGS=" + JSON.stringify(timings));
  image(latest);
} finally {
  await tools.delete({ path: opened.sandbox });
}`;
    const run = await new PiIntegrationTest({
      testName: `window-read-latency-${machine}`, artifactsDir: testArtifactsDir(import.meta.filename), cwd, piCommand: PI_COMMAND,
      isolateUserResources: true, transport: "rpc", timeoutMs: 300_000,
      tools: ["codemode", "read", "delete", "computer_open"],
      extensions: [IDE_EXTENSION, path.join(root, "src/index.ts"), path.join(root, "test/fixtures/codemode-extension.ts"),
        ...(probe ? [path.resolve(probe)] : [])],
      conversation: [
        assistantMessage([toolCall({ id: callId, name: "codemode", arguments: { code },
          chunks: { kind: "fixed", size: Number.MAX_SAFE_INTEGER } })], { stopReason: "toolUse" }),
        assistantMessage([text("Finished the window-read latency probe.")]),
      ],
    }).run("Measure fresh image reads of Notepad in a disposable isolated Windows session.");

    const report = getToolResultText(run, callId);
    expect(getToolExecution(run, callId).isError, report).toBe(false);
    const nested = nestedCalls(getToolExecutions(run), callId);
    const reads = nested.filter(call => call.name === "read");
    expect(reads).toHaveLength(warmups + samples);
    expect(nested.find(call => call.name === "delete")?.computer.status).toBe("closed");
    const observations = new Set<string>();
    for (const { computer } of reads) {
      expect(computer).toMatchObject({ status: "observed", granularity: "image", captured: { image: true, ui: false },
        source_identity: { domain: "windows-session" }, observation_id: expect.any(String) });
      const { width, height, bytes } = computer.agent_image.output as { width: number; height: number; bytes: number };
      expect(Math.min(width, height)).toBeGreaterThan(0);
      expect(Math.max(width, height)).toBeLessThanOrEqual(maxLongEdge);
      if (maxLongEdge === 320) expect(Math.max(width, height)).toBe(320);
      expect(bytes).toBeGreaterThan(0);
      observations.add(computer.observation_id);
    }
    expect(observations.size).toBe(reads.length);

    const timingsLine = /^READ_TIMINGS=(\[[^\n]+\])$/m.exec(report);
    expect(timingsLine, report).not.toBeNull();
    const ms = JSON.parse(timingsLine![1]) as number[];
    expect(ms).toHaveLength(samples);
    expect(ms.every(value => Number.isFinite(value) && value >= 0)).toBe(true);
    const sorted = ms.toSorted((a, b) => a - b);
    const percentile = (fraction: number) => sorted[Math.ceil(fraction * sorted.length) - 1];
    const p95 = percentile(0.95);
    console.log(JSON.stringify({ machine, maxLongEdge, warmups, samples, p50: percentile(0.5), p95, max: sorted.at(-1), ms }));
    // SSH adds transport cost; the acceptance ceiling is for the local WSL → Windows path.
    if (machine === "local" && maxLongEdge === 320 && process.env.LIVE_READ_BASELINE !== "1") expect(sorted.at(-1)).toBeLessThan(150);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

/** An isolated Pi does not see the user's machines or project driver override. Copy only what this run needs. */
async function configureMachine(cwd: string, name: string): Promise<void> {
  const config = path.join(cwd, ".pi/computer-use.json");
  await mkdir(path.dirname(config));
  if (name === "local") {
    try {
      await copyFile(path.join(root, ".pi/computer-use.json"), config);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // If no override is configured, the extension resolves the driver normally.
    }
    return;
  }
  const selected = (await readMachineSettings(root)).machines[name];
  if (!selected) throw new Error(`The live machine ${name} is not configured for computer use.`);
  await writeFile(config, JSON.stringify({ machines: { [name]: selected } }));
}
