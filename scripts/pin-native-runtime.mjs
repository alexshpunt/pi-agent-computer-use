import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const targets = {
  "win32-x64": ["cua-driver.exe", "cua-cursor-theme.exe", "cua-driver-uia.exe"],
  "linux-x64": ["cua-driver", "cua-cursor-theme"],
  "darwin-x64": ["cua-driver", "cua-cursor-theme"],
  "darwin-arm64": ["cua-driver", "cua-cursor-theme"],
};

/** Convert checked complete-set evidence into extension pins. This does not establish GUI qualification. */
export function runtimePins(complete) {
  if (!/^[0-9a-f]{40}$/.test(complete?.source) || !Array.isArray(complete.packages) || complete.packages.length !== 4)
    throw new Error("Expected one complete four-target source set.");
  const first = complete.packages[0];
  const version = `${first.driver_version}-dev.${complete.source.slice(0, 12)}`;
  const pins = { format: 1, source: complete.source, version, driverVersion: first.driver_version, targets: {} };
  if (!/^\d+\.\d+\.\d+$/.test(pins.driverVersion)) throw new Error("Invalid native driver version.");
  for (const entry of complete.packages) {
    const names = targets[entry.target]?.concat("LICENSE.md", "THIRD_PARTY_NOTICES.md");
    if (!names || pins.targets[entry.target] || entry.source !== pins.source || entry.version !== version || entry.driver_version !== pins.driverVersion)
      throw new Error("Missing, duplicate, wrong-version or mixed-source runtime target.");
    if (JSON.stringify(Object.keys(entry.files ?? {}).sort()) !== JSON.stringify(names.sort())
      || Object.values(entry.files).some(hash => typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash)))
      throw new Error("Missing companion/notice or invalid file hash.");
    pins.targets[entry.target] = { files: entry.files };
  }
  return pins;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [directory, output] = process.argv.slice(2);
  if (!directory || !output) throw new Error("Usage: node scripts/pin-native-runtime.mjs <complete-artifact-directory> <output-json>");
  const pins = runtimePins(JSON.parse(await readFile(path.join(directory, "complete-set.json"), "utf8")));
  for (const target of Object.keys(targets)) {
    const root = path.join(directory, `native-runtime-${target}-${pins.source}`);
    const installation = JSON.parse(await readFile(path.join(root, "installation.json"), "utf8"));
    const startup = JSON.parse(await readFile(path.join(root, "installed-startup.json"), "utf8"));
    if (installation.source !== pins.source || installation.target !== target
      || JSON.stringify(Object.entries(installation.files).sort()) !== JSON.stringify(Object.entries(pins.targets[target].files).sort())
      || startup.source !== pins.source || startup.target !== target || startup.server?.name !== "cua-driver" || startup.server.version !== pins.driverVersion || startup.input_calls !== 0 || startup.capture_calls !== 0 || !startup.tools?.length)
      throw new Error(`Missing installed read-only API evidence: ${target}`);
  }
  await writeFile(output, JSON.stringify(pins, null, 2) + "\n");
  console.log(JSON.stringify({ source: pins.source, version: pins.version, targets: Object.keys(pins.targets), output, gui_qualification: "separate" }));
}
