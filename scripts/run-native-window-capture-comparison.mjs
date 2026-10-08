import assert from "node:assert/strict";
import path from "node:path";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

// Finish exact, already dispatched build runs serially, then perform one owned read-only comparison.
// A cancelled queue entry may be rerun once; source failures and unknown results stop the program.
const exec = promisify(execFile);
const [input, permission] = process.argv.slice(2);
assert.equal(permission, "--owned-fixture");
const plan = JSON.parse(await readFile(input, "utf8"));
const roles = ["wgc", "baseline", "direct", "wgcPoll5"];
assert.deepEqual(Object.keys(plan.runs).sort(), [...roles].sort());
const directory = path.resolve(".tmp/window-capture-latency");
await mkdir(directory, { recursive: true });
const args = ["--repo", "alexshpunt/cua"];
const runGh = async command => {
  try {
    const result = await exec("gh", command, { timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
    return result.stdout;
  } catch (error) {
    await writeFile(path.join(directory, "private-build-failure.log"), [error.message, error.stdout, error.stderr].filter(Boolean).join("\n"));
    throw Error("GitHub operation stopped; inspect private-build-failure.log. No build replay.");
  }
};
const variants = {};
for (const role of roles) {
  const entry = plan.runs[role];
  assert.ok(Number.isSafeInteger(entry.id) && entry.id > 0);
  assert.match(entry.source, /^[a-f0-9]{40}$/);
  const id = String(entry.id);
  const readState = async () => JSON.parse(await runGh(["api", `repos/alexshpunt/cua/actions/runs/${id}`, "--jq", "{headSha:.head_sha,status,conclusion,attempt:.run_attempt}"]));
  const state = await readState();
  assert.equal(state.headSha, entry.source, "Run must belong to the exact requested diagnostic commit");
  assert.ok(Number.isSafeInteger(state.attempt) && state.attempt >= 1 && state.attempt <= 2, "At most one queue rerun is admitted");
  if (state.status === "completed") {
    assert.ok(["success", "cancelled"].includes(state.conclusion), "Failed source build needs inspection, not automatic replay");
    if (state.conclusion === "cancelled") {
      assert.equal(state.attempt, 1, "A cancelled second attempt cannot be replayed");
      await runGh(["run", "rerun", id, ...args]);
    }
  }
  // Short gh invocations use the managed credential wrapper each time. A long
  // gh watch can keep one token past its lease. Never bypass the wrapper.
  const deadline = Date.now() + 70 * 60 * 1000;
  let verified = state;
  while (verified.status !== "completed" || verified.conclusion === "cancelled") {
    assert.ok(Date.now() < deadline, "Build wait budget exhausted");
    if (verified !== state) await delay(60000);
    verified = await readState();
    assert.equal(verified.headSha, entry.source);
    if (verified.status === "completed" && !(state.conclusion === "cancelled" && verified.attempt === state.attempt)) {
      assert.equal(verified.conclusion, "success", "Build did not succeed; no automatic replay");
    }
  }
  await writeFile(path.join(directory, `build-${role}.json`), JSON.stringify(verified, null, 2) + "\n");
  assert.equal(verified.headSha, entry.source); assert.equal(verified.status, "completed"); assert.equal(verified.conclusion, "success");
  const artifact = path.join(directory, `artifacts-${role}`);
  // A resumed successful download may be reused only after every file's provenance and hash check.
  try { await readFile(path.join(artifact, "source-sha.txt")); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    await runGh(["run", "download", id, ...args, "--name", `windows-fork-build-${entry.source}`, "--dir", artifact]);
  }
  assert.equal((await readFile(path.join(artifact, "source-sha.txt"), "utf8")).trim(), entry.source);
  const hashes = JSON.parse(await readFile(path.join(artifact, "hashes.json"), "utf8"));
  assert.deepEqual(hashes.map(row => row.name).sort(), ["cua-driver.exe", "cua-driver-uia.exe", "cua-cursor-theme.exe"].sort());
  for (const row of hashes) {
    const actual = createHash("sha256").update(await readFile(path.join(artifact, "runtime", row.name))).digest("hex");
    assert.equal(actual, row.Hash.toLowerCase());
  }
  variants[role] = { source: entry.source, directory: artifact, sha256: hashes.find(row => row.name === "cua-driver.exe").Hash.toLowerCase() };
  console.log(JSON.stringify({ role, source: entry.source, build: entry.id, artifact_verified: true }));
}
const comparison = { config: plan.config, installed_sha256: plan.installed_sha256, ...(plan.interop ? { interop: plan.interop } : {}), variants };
const comparisonPath = path.join(directory, "comparison-plan.json");
await writeFile(comparisonPath, JSON.stringify(comparison, null, 2) + "\n");
const result = await exec(process.execPath, ["--experimental-transform-types", "scripts/qualify-native-window-capture.mjs", comparisonPath, "--owned-fixture"], { timeout: 10 * 60 * 1000, maxBuffer: 65536 });
console.log(result.stdout.trim());
