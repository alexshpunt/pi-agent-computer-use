import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

// Offline synthetic evidence export. No browser, Driver, capture or input is started.
const phase = process.argv[2];
assert.ok(["first-model", "final-model", "foreground-model", "native", "native-foreground"].includes(phase), "Use a named model/native evidence phase.");
const sourceDirectory = process.argv[3];
if (phase.includes("foreground")) assert.ok(sourceDirectory?.startsWith(".tmp/cua-pivot/"), "Pass the actual foreground run directory.");
const root = path.resolve("docs/evidence/cua-browser");
await mkdir(root, { recursive: true });
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
async function saveImage(directory, filename, name) {
  assert.match(filename, /^[a-zA-Z0-9-]+\.(png|jpg)$/);
  const source = path.join(directory, filename);
  const bytes = await readFile(source);
  const output = `${name}${path.extname(filename)}`;
  await copyFile(source, path.join(root, output));
  return { file: output, bytes: bytes.length, sha256: hash(bytes) };
}
const compact = value => JSON.parse(JSON.stringify(value, (key, item) =>
  ["image", "data", "base64"].includes(key) ? undefined : item));
let proof;
if (phase.endsWith("model")) {
  const directory = sourceDirectory ?? ".tmp/cua-pivot/model";
  const run = JSON.parse(await readFile(path.join(directory, "run.json"), "utf8"));
  const rows = [];
  for (const [index, row] of run.rows.entries()) {
    const images = [];
    for (const filename of row.images) images.push(await saveImage(directory, filename, `${phase}-${index}`));
    rows.push({ tool: row.tool, callId: row.callId, isError: row.isError, text: row.text, details: compact(row.details ?? {}), images });
  }
  proof = { model: run.model, automatedSemanticChecksPassed: run.success, executions: rows.length,
    visualVerification: "Read actual PNGs separately. Matching semantic text and an image block are not proof of matching paint.", rows };
} else {
  const directory = sourceDirectory ?? ".tmp/cua-pivot/adapter-final";
  const run = JSON.parse(await readFile(path.join(directory, "run.json"), "utf8"));
  const records = [];
  for (const [index, row] of run.records.entries()) {
    const images = [];
    for (const image of row.images) images.push(await saveImage(directory, image.filename, `${phase}-${index}`));
    records.push({ operation: row.operation, args: row.args, elapsed_ms: row.elapsed_ms, details: compact(row.details), images });
  }
  proof = { records, nativeCalls: compact(run.nativeCalls), source: "Real Windows CUA on synthetic loopback fixture; not adapter mocks." };
}
await writeFile(path.join(root, `${phase}.json`), JSON.stringify(proof, null, 2) + "\n");
console.log(JSON.stringify({ phase, directory: root, records: proof.rows?.length ?? proof.records?.length }));
