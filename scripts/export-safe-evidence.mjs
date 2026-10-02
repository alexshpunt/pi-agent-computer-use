import assert from "node:assert/strict";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

// Offline export only. Pass this qualification's OWN Pi session file, not another agent's history.
// .tmp inputs come from native qualification and read-only cleanup; never export a failed run as a pass.
const sessionFile = process.argv[2];
const ownedId = Number(process.argv[3]);
const tuiRevision = Number(process.argv[4]);
assert.ok(sessionFile && Number.isSafeInteger(ownedId) && ownedId > 0 && Number.isSafeInteger(tuiRevision) && tuiRevision > 0,
  "Usage: node scripts/export-safe-evidence.mjs <own-session.jsonl> <owned-window-id> <inspected-pane-revision>");
const prepared = JSON.parse(await readFile(".tmp/safe-prepared.json", "utf8"));
const native = JSON.parse(await readFile(".tmp/safe-native-denial.json", "utf8"));
const cleanup = JSON.parse(await readFile(".tmp/safe-cleanup.json", "utf8"));
assert.equal(native.success, true);
assert.deepEqual(native.deniedCalls, []);
assert.deepEqual(cleanup.remainingHandles, []);
assert.equal(cleanup.ownedDriverCount, 0);
assert.equal(cleanup.identityPeerCount, 0);
const rows = (await readFile(sessionFile, "utf8")).trim().split("\n").map(line => JSON.parse(line));
const messages = rows.filter(row => row.type === "message" && row.message?.role === "toolResult"
  && row.message.toolName?.startsWith("computer_")).map(row => ({ ...row.message, time: row.timestamp }));
const ids = new Set(cleanup.targets.filter(target => target.pid === prepared.target.pid).map(target => target.window_id));
const isTarget = target => target?.pid === prepared.target.pid && ids.has(target.window_id);
const refs = new Set(messages.filter(message => isTarget(message.details?.target)).map(message => message.details.window_ref));
const value = message => message.details?.state?.elements?.find(element => element.role === "Document")?.value ?? "";
const last = predicate => [...messages].reverse().find(predicate);
const observed = (message, id, mode, text) => message.details?.status === "observed"
  && message.details.target?.pid === prepared.target.pid && message.details.target.window_id === id && message.details.mode === mode && value(message) === text;
const owned = last(message => observed(message, ownedId, "safe", "SAFE owned 365 after switch"));
const canary = last(message => observed(message, prepared.target.window_id, "yolo", "SAFE canary 365"));
assert.ok(owned && canary, "Passing interactive observations are missing.");
const denied = messages.filter(message => message.details?.mode === "safe" && message.details.status === "refused"
  && message.details.window_ref && refs.has(message.details.window_ref)
  && message.content.some(block => block.type === "text" && block.text.startsWith("Safe mode allows only")));
assert.ok(denied.some(message => message.toolName === "computer_observe"));
assert.ok(denied.some(message => message.toolName === "computer_act"));
const tui = rows.find(row => row.type === "message" && row.message?.role === "toolResult"
  && row.message.toolName === "inspect_tui" && row.message.details?.paneRevision === tuiRevision)?.message;
const tuiImage = tui?.content.find(block => block.type === "image" && block.mimeType === "image/png");
assert.ok(tuiImage, "The requested actual viewport capture is missing.");
const directory = "docs/evidence/safe";
await mkdir(directory, { recursive: true });
const screenshots = [
  ["owned-open-safe.png", messages.find(message => message.toolName === "computer_open" && observed(message, ownedId, "safe", ""))],
  ["owned-after-switch.png", owned],
  ["canary-restored.png", canary],
  ["canary-cleanup-blank.png", last(message => observed(message, prepared.target.window_id, "yolo", ""))],
  ["owned-cleanup-blank.png", last(message => observed(message, ownedId, "yolo", ""))],
];
for (const [name, message] of screenshots) {
  const image = message?.content.find(block => block.type === "image" && block.mimeType === "image/png");
  assert.ok(image, `Missing scoped PNG: ${name}`);
  await writeFile(path.join(directory, name), Buffer.from(image.data, "base64"));
}
await copyFile(".tmp/safe-canary-after-denial.png", path.join(directory, "native-canary-after-denial.png"));
await writeFile(path.join(directory, "safe-viewport.png"), Buffer.from(tuiImage.data, "base64"));
await writeFile(path.join(directory, "native-denial.json"), JSON.stringify(native, null, 2) + "\n");
await writeFile(path.join(directory, "cleanup.json"), JSON.stringify(cleanup, null, 2) + "\n");
const argumentsById = new Map(rows.filter(row => row.type === "message" && row.message?.role === "assistant")
  .flatMap(row => row.message.content.filter(block => block.type === "toolCall").map(block => [block.id, block.arguments])));
const trace = messages.filter(message => isTarget(message.details?.target)
  || refs.has(message.details?.window_ref ?? argumentsById.get(message.toolCallId)?.window_ref)
  || ["computer_windows", "computer_close"].includes(message.toolName)).map(message => {
  const details = message.details ?? {};
  const state = details.state ?? {};
  return { time: message.time, tool: message.toolName, status: details.status, mode: details.mode,
    target: details.target, window_ref: details.window_ref ?? argumentsById.get(message.toolCallId)?.window_ref,
    observation_id: details.observation_id,
    message: message.content.find(block => block.type === "text")?.text.split("\n")[0],
    ...(Array.isArray(state.elements) ? { documents: state.elements.filter(element => element.role === "Document")
      .map(element => ({ value: element.value ?? "" })), tabs: state.elements.filter(element => element.role === "TabItem").map(element => element.label) } : {}),
    ...(Array.isArray(state.windows) ? { windows: state.windows.filter(isTarget).map(window => ({
      pid: window.pid, window_id: window.window_id, window_ref: window.window_ref, owned: window.owned })) } : {}),
    ...(state.delivery ? { delivery: state.delivery, effect: state.effect, route: state.route } : {}),
  };
});
const output = { sessionId: rows[0].id, sessionFile: path.basename(sessionFile), sessionFileCreated: (await stat(sessionFile)).birthtime,
  userChoices: rows.filter(row => row.type === "custom" && row.customType === "computer-use-mode")
    .map(row => ({ time: row.timestamp, mode: row.data.mode })), canary: prepared.target,
  owned: { pid: prepared.target.pid, window_id: ownedId },
  viewport: tui.details, screenshots: screenshots.map(([name]) => name), trace };
await writeFile(path.join(directory, "parent-run.json"), JSON.stringify(output, null, 2) + "\n");
console.log(JSON.stringify({ directory, toolResults: trace.length, userChoices: output.userChoices, screenshots: output.screenshots }, null, 2));
