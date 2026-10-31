import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { assistantMessage, getToolExecution, getToolExecutionResult, getToolExecutions, getToolResultText, PiIntegrationTest,
  testArtifactsDir, text, toolCall } from "pi-coding-agent-test";
import { expect, test } from "vitest";
import { nestedCalls, SCRIPT_HELPERS } from "./fixtures/standalone-computer.ts";

// Real Pi and MCP, but no claim about native Linux/macOS UI behavior.
test.skipIf(process.platform !== "linux")("real Pi common tools expose portable metadata and refuse deferred lifetime before app launch or input", async () => {
  await mkdir(".tmp/lpt-662", { recursive: true });
  const cwd = await mkdtemp(path.resolve(".tmp/lpt-662/pi-portable-")); const log = path.join(cwd, "calls.jsonl");
  await mkdir(path.join(cwd, ".pi"));
  await writeFile(path.join(cwd, ".pi/computer-use.json"), JSON.stringify({ command: process.execPath,
    args: [path.resolve("test/fixtures/shell-desktop-driver.mjs"), log] }));
  const code = `${SCRIPT_HELPERS}
const listed=await windows("Fixture");
const rows=listed.split("\\n").filter(line=>line.includes("| Fixture"));
if(rows.length!==2)throw Error("Missing synthetic metadata");
if(rows.some(row=>!row.startsWith("(no controllable reference)")))throw Error("Unqualified lifetime admitted");
const launch=await openApp("Synthetic editor");
if(launch.outcome!=="refused"||!/window_lifetime_unavailable/.test(launch.text))throw Error("Unqualified app launch was not refused");
text(JSON.stringify({platform:"linux",metadata:rows.length,lifetime:"deferred",launch:"refused"}));`;
  try {
    const result = await new PiIntegrationTest({ testName: "portable-lifetime-boundary", artifactsDir: testArtifactsDir(import.meta.filename), cwd,
      extensions: [path.resolve("test/fixtures/portable-extension.ts")], isolateUserResources: true,
      tools: ["codemode", "computer_delete"], conversation: [
        assistantMessage([toolCall({ id: "portable", name: "codemode", arguments: { code } })], { stopReason: "toolUse" }),
        assistantMessage([toolCall({ id: "close", name: "computer_delete", arguments: { path: "computer:session" } })], { stopReason: "toolUse" }),
        assistantMessage([text("Portable admission checked without app launch or input.")]),
      ] }).run("Inspect only synthetic metadata and verify deferred lifetime refusal. Do not launch apps or send input.");
    expect(getToolExecution(result, "portable").isError, getToolResultText(result, "portable")).toBe(false);
    // The first Computer Use call also appends the computer guide after the script output.
    expect(JSON.parse(getToolResultText(result, "portable").split("\n").find(line => line.startsWith('{"platform"'))!)).toMatchObject({ metadata: 2, lifetime: "deferred", launch: "refused" });
    expect((getToolExecutionResult(result, "portable") as { content: { type: string }[] }).content.some(block => block.type === "image")).toBe(false);
    const [listed] = nestedCalls(getToolExecutions(result), "portable");
    for (const row of listed.computer.state.windows as { window_ref?: string; unavailable: string[]; source_identity: { domain: string; membership: Record<string, unknown> } }[]) {
      expect(row.window_ref).toBeUndefined();
      expect(row.unavailable).toContain("window_lifetime_unavailable");
      expect(row.source_identity.domain).toBe("linux-host");
      expect(row.source_identity.membership.virtual_desktop_id).toBeNull();
      expect(row.source_identity.membership.windows_session_id).toBeUndefined();
    }
    const calls = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(calls.map(call => call.name)).toEqual(["list_windows"]);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
