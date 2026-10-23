import { lstat, mkdir, readFile, realpath, rename, symlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Bind the peer SDK to one source checkout without installing or changing its dependencies.
const root = path.resolve(import.meta.dirname, "..");
const requested = process.argv[2] ?? process.env.PI_COMPUTER_IDE_SOURCE;
if (!requested) throw new Error("Pass the IDE checkout path, or set PI_COMPUTER_IDE_SOURCE.");
const source = await realpath(requested);
const manifest = JSON.parse(await readFile(path.join(source, "package.json"), "utf8"));
if (
  manifest.name !== "pi-agent-ide" ||
  manifest.exports?.["./api/search"]?.default !== "./src/api/search.ts"
)
  throw new Error("Expected a pi-agent-ide source checkout, not a built package.");
await readFile(path.join(source, "src/pi-agent-ide.ts"), "utf8");
const modules = path.join(root, "node_modules");
await lstat(modules); // Run npm ci first; do not create a partial dependency tree.
const target = path.join(modules, "pi-agent-ide");
let existing;
try {
  existing = await lstat(target);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
if (existing && (await realpath(target)) === source) {
  console.log(`IDE SDK already uses ${source}`);
} else {
  if (existing) {
    const backup = path.join(root, ".tmp", `ide-sdk-before-link-${Date.now()}`);
    await mkdir(path.dirname(backup), { recursive: true });
    await rename(target, backup); // Preserve the old package or link without touching its contents.
    console.log(`Previous SDK saved at ${backup}`);
  }
  await symlink(source, target, process.platform === "win32" ? "junction" : "dir");
  console.log(`IDE SDK uses ${source}`);
}
const entry = await realpath(fileURLToPath(import.meta.resolve("pi-agent-ide/api/search")));
if (entry !== path.join(source, "src/api/search.ts"))
  throw new Error("Search SDK does not resolve to the selected source checkout.");
