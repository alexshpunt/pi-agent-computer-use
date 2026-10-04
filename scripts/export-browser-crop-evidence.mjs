import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

// Export only actual returned PNGs named by the recorded parent proof. Never recreate an image.
const [sessionPath, proofPath, directory] = process.argv.slice(2);
if (!sessionPath || !proofPath || !directory) throw new Error("Supply session JSONL, parent proof and output directory.");
const proof = JSON.parse(await readFile(proofPath, "utf8"));
const wanted = new Map();
for (const name of ["overview", "detail", "nested", ...(proof.preview ? ["preview"] : [])]) {
  const output = proof[name]?.agent_image?.output;
  if (!/^[a-f0-9]{64}$/.test(output?.hash)) throw new Error("Missing recorded output hash: " + name);
  wanted.set(output.hash, { name, output, found: false });
}
await mkdir(directory, { recursive: true });
async function candidate(encoded) {
  const bytes = Buffer.from(encoded, "base64");
  const item = wanted.get(createHash("sha256").update(bytes).digest("hex"));
  if (!item || item.found) return;
  if (bytes.length !== item.output.bytes || bytes.readUInt32BE(16) !== item.output.width || bytes.readUInt32BE(20) !== item.output.height)
    throw new Error("Recorded PNG geometry does not match: " + item.name);
  await writeFile(path.join(directory, item.name + ".png"), bytes); item.found = true;
}
async function visit(value) {
  if (typeof value === "string" && value.startsWith("data:image/png;base64,")) await candidate(value.slice(22));
  else if (value && typeof value === "object") {
    if (value.type === "image" && value.mimeType === "image/png" && typeof value.data === "string") await candidate(value.data);
    for (const child of Object.values(value)) await visit(child);
  }
}
for (const line of (await readFile(sessionPath, "utf8")).split("\n")) if (line.trim()) await visit(JSON.parse(line));
const missing = [...wanted.values()].filter(item => !item.found).map(item => item.name);
if (missing.length) throw new Error("Actual returned PNGs not found: " + missing.join(", "));
await writeFile(path.join(directory, "parent.json"), JSON.stringify(proof, null, 2) + "\n");
console.log(JSON.stringify({ success: true, frames: wanted.size, directory }));
