import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, readdir, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

// Build artifact generator, not an installer. The release keeps DLLs replaceable and ships Qt source separately.
const [bundle, qtKit, qtSource, release] = process.argv.slice(2).map(value => path.resolve(value));
assert.ok(bundle && qtKit && qtSource && release, "Usage: node scripts/package-window-overlay.mjs bundle qtKit qtSource release");
const revision = "5a1194b2d368e2d72c230205c464b04a2f23eccd";
assert.equal(execFileSync("git", ["-C", qtSource, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), revision);
const sbom = JSON.parse(await readFile(path.join(qtKit, "sbom/qtbase-6.11.3.spdx.json"), "utf8"));
for (const name of ["Core", "Gui", "Widgets", "QWindowsIntegrationPlugin"]) {
  const module = sbom.packages.find(item => item.name === name);
  assert.ok(module?.licenseConcluded.includes("LGPL-3.0-only"), `${name} needs an LGPL option in the exact kit SBOM`);
}
assert.ok(!(await stat(release).catch(() => undefined)), "Use a new release directory; never mix stale binaries or manifests.");
await mkdir(release, { recursive: true });
const runtime = path.join(release, "runtime");
await mkdir(runtime, { recursive: true });
await cp(bundle, runtime, { recursive: true });
const legal = path.join(runtime, "licenses"); await mkdir(legal, { recursive: true });
await cp(path.join(qtSource, "LICENSES"), legal, { recursive: true });
await cp(path.join(qtKit, "sbom/qtbase-6.11.3.spdx.json"), path.join(legal, "qtbase-sbom.json"));
await cp(path.resolve("native/window-overlay/NOTICE.md"), path.join(runtime, "NOTICE.md"));
await cp(path.resolve("native/window-overlay"), path.join(release, "helper-source"), { recursive: true });
execFileSync("git", ["-C", qtSource, "archive", "--format=tar.gz", "--prefix=qtbase/", "-o", path.join(release, "qtbase-source.tar.gz"), revision]);
// Preserve the installed kit's public build settings with the corresponding sources.
await cp(path.join(qtKit, "mkspecs/qconfig.pri"), path.join(release, "qt-kit-qconfig.pri"));
const attributions = sbom.packages.filter(item => item.name.includes("Attribution")).map(item => ({
  name: item.name, license: item.licenseConcluded, copyright: item.copyrightText, source: item.downloadLocation,
}));
await writeFile(path.join(legal, "qtbase-attributions.json"), JSON.stringify(attributions, null, 2));
const files = [];
async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(file);
    else {
      const bytes = await readFile(file);
      files.push({ path: path.relative(release, file), bytes: (await stat(file)).size, sha256: createHash("sha256").update(bytes).digest("hex") });
    }
  }
}
await walk(release);
execFileSync("tar", ["-czf", path.join(release, "runtime.tar.gz"), "-C", release, "runtime"]);
const packedRuntime = await stat(path.join(release, "runtime.tar.gz"));
await writeFile(path.join(release, "manifest.json"), JSON.stringify({ qt: "6.11.3", qt_revision: revision, files,
  runtime_bytes: files.filter(item => item.path.startsWith("runtime/")).reduce((sum, item) => sum + item.bytes, 0),
  runtime_archive_bytes: packedRuntime.size,
  total_bytes: files.reduce((sum, item) => sum + item.bytes, 0), source_supplied: true,
  notices: "Conservative qtbase attribution set includes components not linked by this helper.",
}, null, 2));
console.log(JSON.stringify({ release, files: files.length, source_supplied: true }));
