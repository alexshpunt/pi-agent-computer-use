import { mkdir, writeFile } from "node:fs/promises";
import { loadComputerConfig } from "../src/config.ts";
import { McpDriver } from "../src/driver.ts";

// Opt-in, read-only Windows qualification. Full-display pixels may contain private windows.
if (!process.argv.includes("--allow-primary-display")) throw new Error("Explicit primary-display read permission is required.");
const directory = ".tmp/display-observation/native-probe";
await mkdir(directory, { recursive: true });
const driver = new McpDriver(await loadComputerConfig(process.cwd()));
try {
  for (const [name, args] of [["get_screen_size", {}], ["get_desktop_state", { max_image_dimension: 500 }]]) {
    const result = await driver.call(name, args);
    const images = result.content.filter(block => block.type === "image");
    await writeFile(`${directory}/${name}.json`, JSON.stringify({ ...result, content: result.content.filter(block => block.type !== "image") }, null, 2));
    for (const [index, image] of images.entries()) await writeFile(`${directory}/${name}-${index}.png`, Buffer.from(image.data, "base64"));
    console.log(JSON.stringify({ name, state: result.structuredContent, isError: result.isError, images: images.length }));
  }
} finally { await driver.close(); }
