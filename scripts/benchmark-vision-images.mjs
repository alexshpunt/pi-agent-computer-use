import { mkdir, readFile, writeFile } from "node:fs/promises";
import sharp from "sharp";
import { VisionImages, visionKernels } from "../src/vision-images.ts";

// Offline pixel/timing comparison. No model calls; every candidate starts with the same original.
const [sourcePath, directory = ".tmp/vision-scale/benchmark"] = process.argv.slice(2);
if (!sourcePath) throw new Error("Usage: benchmark-vision-images.mjs <original.png> [directory]");
await mkdir(directory, { recursive: true });
const original = (await readFile(sourcePath)).toString("base64");
const records = [];
for (const scale of [1, 0.75, 0.5, 0.25]) for (const kernel of visionKernels) {
  const images = new VisionImages();
  const configuration = images.update({ kernel, maxLongEdge: 800, scale });
  // One untimed warm-up is explicit; five measured local processing runs, not model-cache warming.
  await images.process(original, configuration);
  const runs = [];
  let frame;
  for (let n = 0; n < 5; n++) { frame = await images.process(original, configuration); runs.push(frame.metadata.timings); }
  const actual = await sharp(Buffer.from(frame.png, "base64")).metadata();
  if (Math.max(actual.width, actual.height) > Math.floor(800 * scale)) throw new Error("Oversized encoded PNG.");
  await writeFile(directory + "/" + kernel + "-" + scale + ".png", Buffer.from(frame.png, "base64"));
  const median = key => runs.map(run => run[key]).sort((a, b) => a - b)[2];
  records.push({ ...frame.metadata, median_ms: Object.fromEntries(["decode_ms", "resample_ms", "encode_ms", "total_ms"].map(key => [key, median(key)])), runs });
}
await writeFile(directory + "/run.json", JSON.stringify({ sourcePath, versions: sharp.versions, records, unavailable: ["provider preprocessing", "model embeddings", "universal readability threshold"] }, null, 2) + "\n");
console.log(JSON.stringify({ directory, records: records.map(row => ({ kernel: row.configuration.kernel, scale: row.configuration.scale, width: row.output.width, height: row.output.height, bytes: row.output.bytes, median_ms: row.median_ms })) }, null, 2));
