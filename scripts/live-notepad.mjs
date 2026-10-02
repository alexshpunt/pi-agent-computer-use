import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  getToolCallNames, getToolExecutionDetails, getToolExecutions,
  PiIntegrationTest,
} from "pi-coding-agent-test";

// Opt-in live qualification. The operator must prepare and authorize one empty Notepad window first.
const root = process.cwd();
const config = JSON.parse(await readFile(path.join(root, ".pi/computer-use.json"), "utf8"));
await mkdir(".tmp", { recursive: true });
const cwd = await mkdtemp(path.join(root, ".tmp/native-notepad-"));
await mkdir(path.join(cwd, ".pi"));
await copyFile(path.join(root, ".pi/computer-use.json"), path.join(cwd, ".pi/computer-use.json"));
const result = await new PiIntegrationTest({
  testName: "native-windows-notepad",
  artifactsDir: path.join(root, ".tmp/native-runs"),
  cwd,
  extensions: [path.join(root, "src/index.ts")],
  tools: ["computer_windows", "computer_observe", "computer_act", "computer_close"],
  providerMode: "user",
  isolateUserResources: true,
  rawMode: false,
  timeoutMs: 180_000,
}).run(`You are qualifying a standalone computer-use extension, not Pi Agent IDE.
The operator prepared ONE empty Windows Notepad document, target ${JSON.stringify(config.target)}.
Use only the four supplied computer tools. Never act on a different target or save files.
1. Discover the configured window, then observe it. Confirm it is a single empty Notepad document; otherwise stop without writing.
2. Insert exactly "Pi computer use PoC 123". Ground each action in the latest observation_id and element_token or screenshot coordinates. Each dispatched attempt consumes the observation: always obtain fresh state before the next action.
3. Observe again and verify the actual document text. Change the suffix 123 to 456 through UI input. set_value replaces an element's entire value; use it only if supported. Otherwise use select_all and type_text, observing between actions.
4. Observe again and verify exactly "Pi computer use PoC 456" in the editor, using BOTH tree and screenshot. Never treat input delivery as task success.
Try background delivery first for each action. Foreground is authorized only for this test target, explicitly after a real refusal or observed no-op. Never retry an unknown outcome blindly.
5. Leave the test document open for the parent agent's visible screenshot check; do not close it yet. Call computer_close to release your owned Driver runtime. Report the result and required delivery mode honestly.`);
const executions = getToolExecutions(result);
const observations = executions.filter((execution) => execution.toolName === "computer_observe")
  .map((execution) => getToolExecutionDetails(execution));
const expected = "Pi computer use PoC 456";
const final = observations.at(-1);
const textConfirmed = final?.status === "observed" && Array.isArray(final.state?.elements)
  && final.state.elements.some((element) => element.value === expected);
const summary = {
  target: config.target,
  driverVersion: "0.32.0",
  toolNames: getToolCallNames(result),
  textConfirmed,
  observations,
  artifacts: result.artifacts,
};
await writeFile(path.join(root, ".tmp/native-live-summary.json"), JSON.stringify(summary, null, 2) + "\n");
console.log(JSON.stringify({ textConfirmed, toolNames: summary.toolNames, artifacts: result.artifacts }, null, 2));
if (!textConfirmed) process.exitCode = 1;
