import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { assistantMessage, getToolExecution, getToolResultMessage, getToolResultText, PiIntegrationTest, testArtifactsDir, text, toolCall } from "pi-coding-agent-test";
import { expect, test } from "vitest";

const root = path.resolve(import.meta.dirname, "..");
const code = `const found = await tools.search({path:"computer:windows",query:"Native DOM detail fixture"});
const window = found.match(/computer:window\\/[a-zA-Z0-9-]+/)?.[0];
if(!window) throw Error("No exact fixture window");
const dom = await tools.read({path:window,views:['dom:{"locator":{"test_id":"advance"}}']});
const observation = dom.match(/computer:observation\\/[a-zA-Z0-9-]+/)?.[0];
const hint = dom.match(/^([0-9]+:[a-z0-9]+) \\|/m)?.[1];
if(!observation || !hint || !dom.includes('data-testid') || !dom.includes('Advance')) throw Error("DOM locator did not select the fixture element");
for(const operation of ["crop","highlight"]){
  // IDE forwards native images alongside the script result; the callable value is the sanitized receipt text.
  const receipt = await tools.read({path:observation,views:["element:"+operation+","+hint]});
  if(typeof receipt!=="string" || !receipt.includes("candidate_not_raster_qualified") || !receipt.includes("input=none") || !receipt.includes("paint=unverified")) throw Error("CodeMode lost native detail limits");
  text(receipt);
}
let denial; try { await tools.insert({path:observation,text:'{"action":"click","x":1,"y":1}'}); } catch(error) { denial=String(error); }
if(!denial) throw Error("Readonly DOM detail became input authority");
await tools.insert({path:"computer:session",text:'{"action":"close"}'});
text("CodeMode native DOM selection/crop/highlight contract passed");`;

for (const providerFirst of [false, true]) test(`CodeMode preserves DOM-selected native PNG and readonly limits (providerFirst=${providerFirst})`, async () => {
  await mkdir(path.join(root, ".tmp/lpt-733"), { recursive: true });
  const cwd = await mkdtemp(path.join(root, ".tmp/lpt-733/pi-codemode-detail-"));
  const log = path.join(cwd, "calls.jsonl");
  const fixture = path.join(root, "test/fixtures/dom-native-detail-extension.ts");
  const ide = path.join(process.env.PI_DOM_DETAIL_IDE_SOURCE ?? "/root/dev/pi/pi-agent-ide", "src/pi-agent-ide.ts");
  try {
    await mkdir(path.join(cwd, ".pi"));
    await writeFile(path.join(cwd, ".pi/computer-use.json"), JSON.stringify({ command: process.execPath,
      args: [path.join(root, "test/fixtures/dom-native-detail-driver.mjs"), log] }));
    const result = await new PiIntegrationTest({
      testName: `codemode-native-detail-${providerFirst}`, artifactsDir: testArtifactsDir(import.meta.filename), cwd,
      isolateUserResources: true, rawMode: false, piCommand: "/usr/bin/pi",
      extensions: providerFirst ? [fixture, ide] : [ide, fixture], tools: ["read", "search", "insert", "codemode"], timeoutMs: 90_000,
      conversation: [assistantMessage([toolCall({ id: "native-codemode", name: "codemode", arguments: { code } })], { stopReason: "toolUse" }),
        assistantMessage([text("Finished the synthetic CodeMode image-boundary check.")])],
    }).run("Use only the synthetic MCP fixture. No native desktop, browser launch, capture or real input is available or authorized.");
    expect(getToolExecution(result, "native-codemode").isError, getToolResultText(result, "native-codemode")).toBe(false);
    expect(getToolResultText(result, "native-codemode")).toContain("CodeMode native DOM selection/crop/highlight contract passed");
    const images = getToolResultMessage(result, "native-codemode").content.filter(block => block.type === "image");
    expect(images).toHaveLength(2);
    const expected = await sharp({ create: { width: 19, height: 16, channels: 4, background: { r: 24, g: 48, b: 96, alpha: 1 } } }).png().toBuffer();
    expect(createHash("sha256").update(Buffer.from(images[0]!.data, "base64")).digest("hex")).toBe(createHash("sha256").update(expected).digest("hex"));
    expect(images[1]!.data).not.toBe(images[0]!.data);
    const rows = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(rows.filter(row => row.name === "zoom")).toHaveLength(2);
    expect(rows.filter(row => row.arguments.native_geometry_ref !== undefined)).toHaveLength(6);
    expect(rows.filter(row => row.name === "end_session")).toHaveLength(1);
    expect(rows.every(row => ["fixture_identity", "list_windows", "start_session", "end_session", "get_browser_state", "zoom"].includes(row.name))).toBe(true);
  } finally { await rm(cwd, { recursive: true, force: true }); }
}, 100_000);
