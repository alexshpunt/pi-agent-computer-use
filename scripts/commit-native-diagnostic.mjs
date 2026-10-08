import assert from "node:assert/strict";
import path from "node:path";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

// Turn a checked trace-generator manifest into a diagnostic child commit.
// The source checkout and its normal index are never edited. This does not
// build, install, select or push a runtime; diagnostic branches cannot be adopted.
const [repo, manifestPath, branch] = process.argv.slice(2);
assert.ok(repo && manifestPath && branch, "Usage: node scripts/commit-native-diagnostic.mjs REPO MANIFEST diagnostic/NAME");
assert.match(branch, /^diagnostic\/[a-z0-9-]+$/);
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
assert.match(manifest.source, /^[0-9a-f]{40}$/);
const generated = path.resolve(manifest.directory);
assert.ok(generated.startsWith(path.resolve(".tmp") + path.sep));
assert.ok(Array.isArray(manifest.files) && manifest.files.length > 0 && manifest.files.length <= 16);
assert.equal(new Set(manifest.files.map(row => row.file)).size, manifest.files.length);
const git = (args, env = process.env) => execFileSync("git", ["-C", repo, ...args], { env, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }).trim();
assert.equal(git(["rev-parse", manifest.source]), manifest.source);
const refs = git(["for-each-ref", "--format=%(refname)", `refs/heads/${branch}`]);
assert.equal(refs, "", "Never replace an existing diagnostic branch.");
const before = git(["status", "--porcelain=v1"]);
const directory = await mkdtemp(path.join(path.resolve(".tmp"), "diagnostic-index-"));
try {
  const env = { ...process.env, GIT_INDEX_FILE: path.join(directory, "index") };
  git(["read-tree", manifest.source], env);
  for (const row of manifest.files) {
    assert.match(row.file, /^libs\/cua-driver\/rust\/crates\/[a-z-]+\/src\/[a-z0-9_/.]+\.rs$/);
    assert.ok(!row.file.split("/").includes(".."));
    assert.match(row.sha256, /^[0-9a-f]{64}$/);
    const file = path.join(generated, row.file);
    const bytes = await readFile(file);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), row.sha256);
    const blob = git(["hash-object", "-w", file]);
    git(["update-index", "--add", "--cacheinfo", `100644,${blob},${row.file}`], env);
  }
  git(["diff", "--cached", "--check"], env);
  const tree = git(["write-tree"], env);
  const commit = git(["commit-tree", tree, "-p", manifest.source, "-m", `chore(cua-driver): diagnostic observation timing (${branch})`]);
  git(["update-ref", `refs/heads/${branch}`, commit, "0000000000000000000000000000000000000000"]);
  assert.equal(git(["status", "--porcelain=v1"]), before);
  console.log(JSON.stringify({ source: manifest.source, diagnostic: commit, branch, files: manifest.files.length, checkout_unchanged: true }));
} finally {
  await rm(directory, { recursive: true, force: true });
}
