import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

// Export only recorded agent PNGs whose hashes match an already graded trial manifest.
// Usage: node scripts/export-vision-scale-frames.mjs <session.jsonl> <manifest.json> <directory>
const [sessionPath, manifestPath, directory] = process.argv.slice(2);
if (!sessionPath || !manifestPath || !directory) throw new Error("Supply session, graded manifest and output directory.");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const wanted = new Map();
for (const record of manifest.records) {
  const hash = record.image?.output?.hash;
  const kernel = record.image?.configuration?.kernel;
  if (!/^[a-f0-9]{64}$/.test(hash) || !/^[a-f0-9]{32}$/.test(record.trial) ||
    !["lanczos2", "lanczos3", "mitchell", "mks2021"].includes(kernel) || !record.result)
    throw new Error("Expected graded trial records with actual image hashes.");
  wanted.set(hash, { name: `${kernel}-${record.trial}.png`, found: false });
}
await mkdir(directory, { recursive: true });
async function candidate(encoded) {
  const bytes = Buffer.from(encoded, "base64");
  const item = wanted.get(createHash("sha256").update(bytes).digest("hex"));
  if (!item || item.found) return;
  await writeFile(path.join(directory, item.name), bytes);
  item.found = true;
}
async function visit(value) {
  if (typeof value === "string" && value.startsWith("data:image/png;base64,")) {
    await candidate(value.slice(22));
  } else if (value && typeof value === "object") {
    if (value.type === "image" && value.mimeType === "image/png" && typeof value.data === "string")
      await candidate(value.data);
    for (const child of Object.values(value)) await visit(child);
  }
}
for (const line of (await readFile(sessionPath, "utf8")).split("\n")) if (line.trim()) await visit(JSON.parse(line));
const missing = [...wanted].filter(([, item]) => !item.found).map(([hash]) => hash);
if (missing.length) throw new Error("Recorded PNGs not found: " + missing.join(", "));
console.log(JSON.stringify({ success: true, frames: wanted.size, directory }));
