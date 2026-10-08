import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";

async function evidence() {
  await mkdir(".tmp/lpt-662", { recursive: true });
  const root = await mkdtemp(path.resolve(".tmp/lpt-662/pin-generator-"));
  const source = "a".repeat(40);
  const packages = ["win32-x64", "linux-x64", "darwin-x64", "darwin-arm64"].map(target => ({
    source, target, version: "0.34.0-dev.aaaaaaaaaaaa", driver_version: "0.34.0",
    files: Object.fromEntries((target === "win32-x64" ? ["cua-driver.exe", "cua-cursor-theme.exe", "cua-driver-uia.exe"] : ["cua-driver", "cua-cursor-theme"])
      .concat("LICENSE.md", "THIRD_PARTY_NOTICES.md").map(name => [name, "b".repeat(64)])),
  }));
  const complete = { source, packages };
  await writeFile(path.join(root, "complete-set.json"), JSON.stringify(complete));
  for (const entry of packages) {
    const directory = path.join(root, `native-runtime-${entry.target}-${source}`);
    await mkdir(directory);
    await writeFile(path.join(directory, "installation.json"), JSON.stringify({ source, target: entry.target, files: entry.files }));
    await writeFile(path.join(directory, "installed-startup.json"), JSON.stringify({ source, target: entry.target, server: { name: "cua-driver", version: entry.driver_version }, input_calls: 0, capture_calls: 0, tools: ["list_windows"] }));
  }
  const output = path.join(root, "pins.json");
  const generate = () => promisify(execFile)(process.execPath, ["scripts/pin-native-runtime.mjs", root, output]);
  return { root, complete, output, generate };
}

test("pin generation requires matching installed read-only evidence for one exact four-target set", async () => {
  const { root, complete, output, generate } = await evidence();
  try {
    await generate();
    const pins = JSON.parse(await readFile(output, "utf8"));
    expect(pins).toMatchObject({ format: 1, source: complete.source, driverVersion: "0.34.0" });
    expect(Object.keys(pins.targets)).toEqual(complete.packages.map(entry => entry.target));
    await rm(output);
    await rm(path.join(root, `native-runtime-linux-x64-${complete.source}`, "installed-startup.json"));
    await expect(generate()).rejects.toThrow();
    expect(await readFile(output, "utf8").catch(() => "")).toBe("");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test.each(["missing", "duplicate", "source", "hash"])("%s evidence cannot write extension pins", async defect => {
  const { root, complete, output, generate } = await evidence();
  try {
    if (defect === "missing") complete.packages.pop();
    if (defect === "duplicate") complete.packages[3] = complete.packages[0];
    if (defect === "source") complete.packages[0].source = "c".repeat(40);
    if (defect === "hash") complete.packages[0].files["LICENSE.md"] = "wrong hash";
    await writeFile(path.join(root, "complete-set.json"), JSON.stringify(complete));
    await expect(generate()).rejects.toThrow();
    expect(await readFile(output, "utf8").catch(() => "")).toBe("");
  } finally { await rm(root, { recursive: true, force: true }); }
});
