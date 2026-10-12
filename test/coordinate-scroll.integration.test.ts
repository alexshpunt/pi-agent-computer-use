import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { assistantMessage, getToolExecution, getToolResultText, PiIntegrationTest, testArtifactsDir, text, toolCall } from "pi-coding-agent-test";
import { expect, test } from "vitest";

const root = path.resolve(import.meta.dirname, "..");
const fixture = (name: string) => path.join(root, "test/fixtures", name);

// Pattern: real-Pi extensions example and the ordinary IDE computer-provider scenarios.
// Contract: actual IDE Insert preserves capture authority and structured uncertain prefixes.
async function scenario(testName: string, scenario: "receipts" | "authority", providerFirst: boolean) {
  const ide = process.env.PI_SCROLL_IDE_SOURCE ?? "/root/dev/pi/pi-agent-ide";
  const manifest = JSON.parse(await readFile(path.join(ide, "package.json"), "utf8"));
  expect(manifest.name, "The integration consumer must be Pi Agent IDE").toBe("pi-agent-ide");
  const consumer = path.join(ide, "src/pi-agent-ide.ts"), provider = fixture("coordinate-scroll-extension.ts");
  await mkdir(path.join(root, ".tmp/lpt-730"), { recursive: true });
  const cwd = await mkdtemp(path.join(root, ".tmp/lpt-730/pi-scroll-")), log = path.join(cwd, "calls.jsonl");
  try {
    await mkdir(path.join(cwd, ".pi"));
    await writeFile(path.join(cwd, ".pi/computer-use.json"), JSON.stringify({ command: process.execPath,
      args: [fixture("coordinate-scroll-driver.mjs"), log] }));
    const result = await new PiIntegrationTest({ testName: `${testName}-${providerFirst ? "provider-first" : "core-first"}`,
      artifactsDir: testArtifactsDir(import.meta.filename), cwd, rawMode: false,
      extensions: providerFirst ? [provider, consumer] : [consumer, provider],
      isolateUserResources: true, piCommand: process.env.PI_SCROLL_PI_COMMAND ?? "/usr/bin/pi", timeoutMs: 90_000,
      tools: ["read", "search", "insert", "verify_coordinate_scroll"],
      conversation: [assistantMessage([toolCall({ id: "scroll", name: "verify_coordinate_scroll", arguments: { scenario } })], { stopReason: "toolUse" }),
        assistantMessage([text("Finished the synthetic coordinate-scroll fixture.")])],
    }).run("Exercise ordinary IDE coordinate scroll against synthetic MCP windows only. Never operate a real desktop or replay unknown input.");
    expect(getToolExecution(result, "scroll").isError, getToolResultText(result, "scroll")).toBe(false);
    expect(getToolResultText(result, "scroll")).toContain(`Scroll ${scenario} contract passed`);
    expect((getToolExecution(result, "scroll").result as { content?: { type: string }[] }).content?.some(block => block.type === "image")).toBe(true);
    expect(result.tuiRenderedOutput).not.toContain("Failed to load extension");
    expect(result.tuiRenderedOutput).not.toContain("already handles");
    return (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  } finally { await rm(cwd, { recursive: true, force: true }); }
}

// Missing native axis fields and explicit zero both mean the same contract default.
const inputCalls = (calls: { name: string; arguments: Record<string, unknown> }[]): { name: string; arguments: Record<string, unknown> }[] => calls.filter(call =>
  !["list_apps", "list_windows", "launch_app", "fixture_identity", "get_window_state", "zoom", "fixture_control"].includes(call.name)).map(call => ({
    ...call, arguments: { ...call.arguments, delta_x: call.arguments.delta_x ?? 0, delta_y: call.arguments.delta_y ?? 0 },
  }));
const native = (x: number, y: number, delta_x: number, delta_y: number, delivery_mode = "foreground") => ({
  pid: 42, window_id: 91, capture_id: expect.any(String), x, y, delta_x, delta_y, unit: "wheel_detents", delivery_mode,
});

test.each([false, true])("ordinary IDE scroll preserves capture-bound deltas and uncertain prefixes (providerFirst=%s)", async providerFirst => {
  const actions = inputCalls(await scenario("coordinate-scroll-receipts", "receipts", providerFirst));
  expect(actions.map(call => call.name)).toEqual(Array(9).fill("scroll_at"));
  expect(actions.map(call => call.arguments)).toEqual([
    native(100, 80, 0, 2, "background"), native(100, 80, -2, 3), native(120, 90, 1, 0),
    ...Array.from({ length: 5 }, () => native(130, 100, 1, 1)), native(130, 100, 1, 1, "background"),
  ]);
  expect(new Set(actions.map(call => call.arguments.capture_id)).size).toBe(actions.length);
}, 120_000);

test.each([false, true])("ordinary IDE scroll keeps image, detail, capability, Safe and native lifetime boundaries (providerFirst=%s)", async providerFirst => {
  expect(inputCalls(await scenario("coordinate-scroll-authority", "authority", providerFirst))).toEqual([
    { name: "scroll_at", arguments: native(100, 80, 0, 2) },
  ]);
}, 120_000);
