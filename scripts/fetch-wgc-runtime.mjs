import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const exec = promisify(execFile);
const [run, source] = process.argv.slice(2);
assert.match(run ?? "", /^\d+$/);
assert.match(source ?? "", /^[a-f0-9]{40}$/);
const directory = path.resolve(".tmp/wgc-integration", "build-" + source);
await mkdir(directory, { recursive: true });
const gh = async args => {
  try { return (await exec("gh", args, { timeout: 120000, maxBuffer: 8 * 1024 * 1024 })).stdout; }
  catch { throw Error("Build inspection/download failed; inspect the exact run before retrying. No build was dispatched."); }
};
const status = JSON.parse(await gh(["run","view",run,"--repo","alexshpunt/cua","--json","status,conclusion,headSha,url"]));
assert.equal(status.status, "completed");
assert.equal(status.conclusion, "success");
assert.equal(status.headSha, source);
await gh(["run","download",run,"--repo","alexshpunt/cua","--name","windows-fork-build-" + source,"--dir",directory]);
const readText = async file => (await readFile(path.join(directory,file),"utf8")).replace(/^\uFEFF/, "").trim();
assert.equal(await readText("source-sha.txt"), source);
assert.match(await readText("version.txt"), /0\.34\.0/);
const records = JSON.parse(await readText("hashes.json"));
assert.ok(Array.isArray(records));
const hashes = {};
for (const name of ["cua-driver.exe","cua-driver-uia.exe","cua-cursor-theme.exe"]) {
  const hash = createHash("sha256").update(await readFile(path.join(directory,"runtime",name))).digest("hex");
  const record = records.find(item => item.name === name);
  assert.equal(record?.Hash?.toLowerCase(), hash);
  hashes[name] = hash;
}
for (const name of ["LICENSE.md","THIRD_PARTY_NOTICES.md","BUILD-NOTICE.txt"]) assert.ok(await readText("runtime/" + name));
const manifest = { source, build: Number(run), artifact: directory, hashes, experimental: true, runtime_adopted: false };
const manifestPath = path.join(directory,"verified-runtime.json");
await writeFile(manifestPath, JSON.stringify(manifest,null,2) + "\n");
console.log(JSON.stringify({ success:true, source, build:Number(run), hashes, manifest:manifestPath }));
