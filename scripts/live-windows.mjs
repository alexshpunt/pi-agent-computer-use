import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { getToolCallNames, getToolExecutionDetails, getToolExecutions, PiIntegrationTest } from "pi-coding-agent-test";
import { loadComputerConfig } from "../src/config.ts";
import { McpDriver } from "../src/driver.ts";
import { ComputerSession } from "../src/session.ts";

// Opt-in live check. Creates only disposable windows; the isolated model has no IDE or shell tool.
const root = process.cwd();
await mkdir(".tmp", { recursive: true });
const cwd = await mkdtemp(path.join(root, ".tmp/native-windows-"));
const config = await loadComputerConfig(root);
const preparation = new ComputerSession(new McpDriver(config));
let canary;
try {
  canary = await preparation.open("Notepad");
  await writeFile(".tmp/native-prepared.json", JSON.stringify(canary.details, null, 2) + "\n");
  const elements = canary.details.state?.elements;
  if (canary.details.status !== "observed" || !Array.isArray(elements)
    || elements.filter(element => element.role === "TabItem").length !== 1
    || !elements.some(element => element.role === "Document" && !element.value))
    throw new Error("Canary is not a verified single empty Notepad. Stop and inspect only this created window.");
} finally { await preparation.close(); }

const tools = ["computer_apps", "computer_open", "computer_windows", "computer_observe", "computer_act", "computer_close"];
const result = await new PiIntegrationTest({
  testName: "native-yolo-windows", artifactsDir: path.join(root, ".tmp/native-runs"), cwd,
  extensions: [path.join(root, "src/index.ts")], tools, providerMode: "user",
  isolateUserResources: true, rawMode: false, timeoutMs: 300_000,
}).run(`Qualify the standalone YOLO Windows extension. Use ONLY supplied computer tools, never shell/IDE/config/native-handle lookup.
The harness just created one disposable EMPTY Notepad outside YOUR current extension session: ${JSON.stringify(canary.details.target)}.
This is the only pre-existing window authorized for reads/writes. Every other pre-existing window is off limits. New test windows opened by you are authorized. Never save a file or change app settings.
1. Discover Notepad windows. Select only the harness canary using its metadata, obtain its window_ref and observe it. Confirm a single empty document by BOTH UI tree and screenshot before writing; otherwise stop without changing it.
2. Write exactly "YOLO existing window 363" in that editor, then observe and verify exact value+pixels. Do not equate delivery with verified change.
3. Open a new Notepad through computer_open (app Notepad). Use its returned FIRST observation immediately to confirm one empty document and write exactly "YOLO automatic window 363". Observe and verify. Keep this window open.
4. Open a SECOND new Notepad while the first and canary still exist. Its ref and native window identity must differ, even if PID is shared. Confirm single empty document by tree+pixels. Open Calculator through the same tool; confirm actual Calculator UI by tree+pixels.
5. Request a clearly nonexistent installed app "PiMissingApp363" once. Confirm explicit refusal, not success or a wrong window.
6. Clear only the two written test editors via current observed element and set_value empty. Observe again and confirm blank+unmodified before closing. Clean up the empty second Notepad too. Prefer the observed "Close Tab" button in a single-tab Notepad: background UIA Invoke worked in parent qualification. Do not confuse it with titlebar Close; titlebar background click can be a no-op.
7. Close only the created Calculator window through its observed Close control. Try background first. Foreground is authorized only after fresh observation proves a background refusal/no-op. An unknown close outcome may already have changed the window: discover/observe before deciding, never retry blindly.
8. Discover Notepad and Calculator metadata and confirm all four disposable windows disappeared. Call computer_close to release owned Driver/identity peer. Report exact results, limits, and input mode honestly.
Every action needs its window's CURRENT observation_id and token or scoped screenshot coordinates. Dispatch consumes the observation. Observe again before each next action. If opening is unknown, discover to understand what happened; do NOT blindly open another app instance. If a real unrelated document appears, stop without touching it.`);

const executions = getToolExecutions(result);
const details = executions.map(execution => ({ tool: execution.toolName, callId: execution.toolCallId,
  isError: execution.isError, details: getToolExecutionDetails(execution) }));
const hasValue = (value, target) => details.some(item => item.details?.status === "observed"
  && (!target || item.details.target?.window_id === target.window_id)
  && item.details.state?.elements?.some(element => element.role === "Document" && element.value === value));
const opened = details.filter(item => item.tool === "computer_open" && item.details?.status === "observed" && item.details.opened);
const native = new McpDriver(config);
let remaining;
try {
  const state = await native.call("list_windows", {});
  if (state.isError || !Array.isArray(state.structuredContent?.windows)) throw new Error("Cannot verify native cleanup.");
  const targets = [canary.details.target, ...opened.map(item => item.details.target)];
  remaining = state.structuredContent.windows.filter(window => targets.some(target => target?.pid === window.pid && target.window_id === window.window_id));
} finally { await native.close(); }
const success = hasValue("YOLO existing window 363", canary.details.target)
  && hasValue("YOLO automatic window 363") && opened.length === 3
  && new Set(opened.map(item => item.details.target.window_id)).size === 3 && remaining.length === 0;
const summary = { success, canary: canary.details.target, driverVersion: "0.32.0", model: result.state.model,
  toolNames: getToolCallNames(result), opened: opened.map(item => item.details.target), remaining,
  details, artifacts: result.artifacts };
await writeFile(".tmp/native-yolo-summary.json", JSON.stringify(summary, null, 2) + "\n");
console.log(JSON.stringify({ success, canary: summary.canary, opened: summary.opened, remaining,
  toolNames: summary.toolNames, artifacts: result.artifacts }, null, 2));
if (!success) process.exitCode = 1;
