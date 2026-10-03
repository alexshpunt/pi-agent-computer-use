import assert from "node:assert/strict";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { browserNativeState } from "./browser-native-state.mjs";

// Export only this qualification's owned records, never the whole Pi session or its user messages.
const sessionFile = process.argv[2];
const revision = Number(process.argv[3]);
assert.ok(sessionFile && Number.isSafeInteger(revision) && revision > 0, "Pass own session.jsonl and inspected viewport revision.");
const native = JSON.parse(await readFile(".tmp/browser-focus/run.json", "utf8"));
const coordinate = JSON.parse(await readFile(".tmp/browser-click/run.json", "utf8"));
const storage = JSON.parse(await readFile(".tmp/browser-native/run.json", "utf8"));
const model = JSON.parse(await readFile(".tmp/browser-model/run.json", "utf8"));
const fixture = JSON.parse(await readFile(".tmp/browser-fixture.json", "utf8"));
const window = JSON.parse(await readFile(".tmp/browser-parent/actual-window.json", "utf8"));
for (const run of [native, coordinate, storage, model]) assert.equal(run.success, true);
const cleanup = await browserNativeState();
assert.equal(cleanup.browserCount, 0); assert.equal(cleanup.workerCount, 0); assert.equal(cleanup.profiles.length, 0);
await assert.rejects(fetch(fixture.url, { signal: AbortSignal.timeout(2000) }), "Owned fixture must be stopped.");
const rows = (await readFile(sessionFile, "utf8")).trim().split("\n").map(line => JSON.parse(line));
const proof = rows.findLast(row => row.customType === "codemode-store" && row.data.set?.focusParent)?.data.set.focusParent;
assert.equal(proof?.closed?.status, "closed");
assert.equal(proof.actions.length, 6);
const focused = proof.observations.find(view => view.name === "focused");
assert.ok(focused);
const choices = ["One", "Two", "Three", "Four"].map(name => focused.elements.find(element => element.name === name)?.hint);
assert.ok(choices.every(Boolean));
assert.deepEqual(proof.actions.slice(0, 4).map(row => row.args.click), choices);
assert.ok(proof.actions.every(row => row.result.status === "acted" && !row.result.image));
const messages = rows.filter(row => row.type === "message" && row.message?.role === "toolResult")
  .map(row => ({ ...row.message, time: row.timestamp }));
const first = messages.find(message => message.details?.calls?.some(call => call.name === "browser_open" && JSON.parse(call.args).url === fixture.url + "/focus"));
assert.ok(first, "Own parent opening missing.");
const browserCalls = messages.filter(message => message.time >= first.time && message.details?.calls?.some(call => call.name.startsWith("browser_")));
const sequence = browserCalls.find(message => message.details.calls.map(call => call.name).join(",") === "browser_act,browser_act,browser_act,browser_act,browser_observe");
const confirmed = browserCalls.find(message => message.details.calls.map(call => call.name).join(",") === "browser_act,browser_act,browser_observe");
assert.ok(sequence && confirmed);
const text = message => message.content.filter(block => block.type === "text").map(block => block.text).join("\n");
assert.match(text(sequence), /Selections: 4/); assert.match(text(confirmed), /Confirmed: Pi focused browser/);
const viewport = messages.find(message => message.toolName === "inspect_tui" && message.details?.paneRevision === revision);
assert.ok(viewport, "Inspected viewport missing.");
assert.match(window.target.title, /Pi focused controls/);
assert.match(window.target.commandLine, /--remote-debugging-pipe/);
const directory = "docs/evidence/browser-focus";
await mkdir(directory, { recursive: true });
const image = async (message, name) => {
  const images = message.content.filter(block => block.type === "image" && block.mimeType === "image/png");
  assert.equal(images.length, 1, name);
  await writeFile(path.join(directory, name), Buffer.from(images[0].data, "base64"));
};
await image(sequence, "parent-selected.png"); await image(confirmed, "parent-confirmed.png"); await image(viewport, "parent-viewport.png");
for (const [source, target] of [[".tmp/browser-focus/hints.png", "native-hints.png"], [".tmp/browser-focus/selected.png", "native-selected.png"],
  [".tmp/browser-parent/actual-window.png", "actual-window.png"], [".tmp/browser-model/7-0.png", "model-selected.png"]])
  await copyFile(source, path.join(directory, target));
const compact = ({ image, ...state }) => state;
const output = { success: true, parent: { viewport: viewport.details,
  observations: proof.observations.map(compact), actions: proof.actions, closed: proof.closed,
  sequences: browserCalls.map(message => ({ tool: message.toolName, calls: message.details.calls, images: message.content.filter(block => block.type === "image").length })),
  actualWindow: window.target }, native, coordinate, storage,
  model: { model: model.model, mainCalls: model.rows.filter(row => !/\/\d+$/.test(row.callId)).length, totalCalls: model.toolNames.length,
    rows: model.rows.map(row => ({ tool: row.tool, callId: row.callId, details: row.details, isError: row.isError, text: row.text, images: row.images })), cleanup: model.cleanup },
  cleanup: { ...cleanup, fixtureStopped: true } };
await writeFile(path.join(directory, "run.json"), JSON.stringify(output, null, 2) + "\n");
console.log(JSON.stringify({ directory, nativeOperations: native.records.length, mainModelCalls: output.model.mainCalls, cleanup }));
