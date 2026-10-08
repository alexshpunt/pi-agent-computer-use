import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

// Run after an ordinary private pi install in a disposable agent directory.
// No model prompt, window launch, capture or input is sent.
const [agentDirectory, workingDirectory] = process.argv.slice(2).map(value => path.resolve(value));
assert(agentDirectory && workingDirectory, "Usage: node --experimental-transform-types scripts/verify-bundled-install.mjs <agent-directory> <clean-cwd>");
const root = path.join(agentDirectory, "npm/node_modules/@alexshp/pi-agent-computer-use");
const metadata = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const pins = JSON.parse(await readFile(path.join(root, "src/runtime-pins.json"), "utf8"));
assert.equal(metadata.name, "@alexshp/pi-agent-computer-use");
assert.equal(Object.keys(metadata.optionalDependencies).length, 4);
for (const target of Object.keys(pins.targets))
  assert.equal(metadata.optionalDependencies[`@alexshp/cua-runtime-${target}`], pins.version);
const settings = JSON.parse(await readFile(path.join(agentDirectory, "settings.json"), "utf8"));
assert(settings.packages.includes("npm:@alexshp/pi-agent-computer-use"));
const installedTargets = [];
for (const target of Object.keys(pins.targets)) {
  const directory = path.join(agentDirectory, `npm/node_modules/@alexshp/cua-runtime-${target}`);
  const manifest = await readFile(path.join(directory, "runtime.json"), "utf8").catch(error => {
    if (error.code !== "ENOENT") throw error;
    return undefined;
  });
  if (!manifest) continue;
  const runtime = JSON.parse(manifest);
  assert.equal(runtime.source, pins.source);
  assert.equal(runtime.version, pins.version);
  assert.equal(runtime.target, target);
  assert.deepEqual(runtime.files, pins.targets[target].files);
  for (const [name, hash] of Object.entries(runtime.files))
    assert.equal(createHash("sha256").update(await readFile(path.join(directory, "runtime", name))).digest("hex"), hash);
  installedTargets.push(target);
}
assert(installedTargets.length > 0, "No native dependency was installed");

const child = spawn("pi", ["--mode", "rpc", "--no-session", "--no-approve", "--no-context-files", "--no-mcp", "--offline"], {
  cwd: workingDirectory, env: { ...process.env, PI_CODING_AGENT_DIR: agentDirectory }, stdio: ["pipe", "pipe", "pipe"],
});
let pending = "", diagnostic = "", checked = false, failure;
const timer = setTimeout(() => { failure = new Error("Pi autoload check timed out"); child.kill(); }, 30_000);
child.stderr.on("data", bytes => { diagnostic = (diagnostic + bytes).slice(-4000); });
child.stdout.on("data", bytes => {
  pending += bytes.toString("utf8");
  let newline;
  while ((newline = pending.indexOf("\n")) >= 0) {
    const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (record.id !== "autoload") continue;
      assert.equal(record.success, true);
      const commands = record.data.commands.filter(command => ["computer-mode", "computer-debug"].includes(command.name));
      assert.equal(commands.length, 2);
      for (const command of commands) {
        assert.equal(command.source, "extension");
        assert.equal(command.sourceInfo.origin, "package");
        assert.equal(command.sourceInfo.baseDir, root);
      }
      checked = true;
    } catch (error) { failure = error; }
    child.stdin.end();
  }
});
child.stdin.write(JSON.stringify({ id: "autoload", type: "get_commands" }) + "\n");
try {
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  if (failure) throw failure;
  assert.equal(code, 0, diagnostic);
  assert(checked, `No Pi autoload receipt: ${diagnostic}`);
} finally { clearTimeout(timer); if (child.exitCode === null) child.kill(); }
console.log(JSON.stringify({ extension: `${metadata.name}@${metadata.version}`, native_source: pins.source,
  native_version: pins.version, installed_targets: installedTargets,
  ordinary_pi_install: true, package_autoload: true, pinned_files: "checked", input_calls: 0, capture_calls: 0,
  limits: "Installation, pinned bytes and autoload only. Native startup and GUI qualification are separate." }));
