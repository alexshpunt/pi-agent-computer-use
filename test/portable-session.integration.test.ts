import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { assistantMessage, getToolExecution, getToolExecutionResult, getToolResultText, PiIntegrationTest,
  testArtifactsDir, text, toolCall } from "pi-coding-agent-test";
import { expect, test } from "vitest";

// Real Pi and MCP, but no claim about native Linux/macOS UI behavior.
test.skipIf(process.platform !== "linux")("real Pi common tools expose portable metadata and refuse deferred lifetime before app launch or input", async () => {
  await mkdir(".tmp/lpt-662", { recursive: true });
  const cwd = await mkdtemp(path.resolve(".tmp/lpt-662/pi-portable-")); const log = path.join(cwd, "calls.jsonl");
  await mkdir(path.join(cwd, ".pi"));
  await writeFile(path.join(cwd, ".pi/computer-use.json"), JSON.stringify({ command: process.execPath,
    args: [path.resolve("test/fixtures/shell-desktop-driver.mjs"), log] }));
  const code = `const raw=await tools.computer_windows({query:"Fixture"});
const state=JSON.parse(raw.slice(raw.indexOf("\\n{")+1)).state;
if(state.windows.length!==2)throw Error("Missing synthetic metadata");
for(const row of state.windows){
 if(row.window_ref||!row.unavailable.includes("window_lifetime_unavailable"))throw Error("Unqualified lifetime admitted");
 if(row.source_identity.domain!=="linux-host"||row.source_identity.membership.virtual_desktop_id!==null||row.source_identity.membership.windows_session_id!==undefined)throw Error("Windows provenance leaked");
}
let refused=false;try{await tools.computer_open({app:"Synthetic editor"});}catch(error){refused=String(error).includes("window_lifetime_unavailable");}
if(!refused)throw Error("Unqualified app launch was not refused");
text({platform:"linux",metadata:state.windows.length,lifetime:"deferred",launch:"refused"});`;
  try {
    const result = await new PiIntegrationTest({ testName: "portable-lifetime-boundary", artifactsDir: testArtifactsDir(import.meta.filename), cwd,
      extensions: [path.resolve("test/fixtures/portable-extension.ts")], isolateUserResources: true,
      tools: ["codemode", "computer_windows", "computer_open", "computer_close"], conversation: [
        assistantMessage([toolCall({ id: "portable", name: "codemode", arguments: { code } })], { stopReason: "toolUse" }),
        assistantMessage([toolCall({ id: "close", name: "computer_close", arguments: {} })], { stopReason: "toolUse" }),
        assistantMessage([text("Portable admission checked without app launch or input.")]),
      ] }).run("Inspect only synthetic metadata and verify deferred lifetime refusal. Do not launch apps or send input.");
    expect(getToolExecution(result, "portable").isError, getToolResultText(result, "portable")).toBe(false);
    expect(JSON.parse(getToolResultText(result, "portable").trim().split("\n").at(-1)!)).toMatchObject({ metadata: 2, lifetime: "deferred", launch: "refused" });
    expect((getToolExecutionResult(result, "portable") as { content: { type: string }[] }).content.some(block => block.type === "image")).toBe(false);
    const calls = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(calls.map(call => call.name)).toEqual(["list_windows"]);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
