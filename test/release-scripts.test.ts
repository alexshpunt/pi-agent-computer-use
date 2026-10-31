import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { integrity, verifyCandidate, verifyCandidateArchive, verifyInstalledPackage, type CandidateEvidence } from "../scripts/release/candidate.ts";
import { insertReleaseNotes } from "../scripts/release/changelog.ts";
import { activeReleaseBranches, canMergeIntoMain } from "../scripts/release/merge-policy.ts";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function directory(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "release-"));
  temporary.push(dir);
  return dir;
}

describe("changelog", () => {
  it("keeps dollar sequences in release notes literal", () => {
    const notes = "- Pass `$NAME`, `$$$ARGS`, `$&` and `$1` captures.";
    expect(insertReleaseNotes("# Changelog\n\n## 0.1.0 — 2026-11-01\n", "## 0.2.0 — 2026-12-01", notes))
      .toBe(`# Changelog\n\n## 0.2.0 — 2026-12-01\n\n${notes}\n\n## 0.1.0 — 2026-11-01\n`);
  });

  it("adds the first release below the title", () => {
    expect(insertReleaseNotes("# Changelog\n", "## 0.1.0 — 2026-11-01", "- First release.")).toBe("# Changelog\n\n## 0.1.0 — 2026-11-01\n\n- First release.\n");
  });

  it("refuses a changelog without its title", () => {
    expect(() => insertReleaseNotes("# Notes\n", "## 0.1.0", "- x")).toThrow("# Changelog");
  });
});

describe("release freeze", () => {
  it("treats only exact version branches as active releases", () => {
    const refs = ["abc\trefs/heads/release/v0.6.3", "def\trefs/heads/release/notes"].join("\n");
    expect(activeReleaseBranches(refs)).toEqual([]);
    expect(activeReleaseBranches(`${refs}\n012\trefs/heads/release/0.6.4`)).toEqual(["release/0.6.4"]);
  });

  it("allows normal merges outside a release", () => {
    expect(canMergeIntoMain([], "develop", [])).toBe(true);
  });

  it("blocks develop and unlabeled changes while a release is active", () => {
    expect(canMergeIntoMain(["release/0.2.0"], "develop", [])).toBe(false);
    expect(canMergeIntoMain(["release/0.2.0"], "fix/release-crash", [])).toBe(false);
    expect(canMergeIntoMain(["release/0.2.0"], "feature/abc", ["release-fix"])).toBe(false);
  });

  it("allows only the release PR or labeled release fixes", () => {
    expect(canMergeIntoMain(["release/0.2.0"], "release/0.2.0", [])).toBe(true);
    expect(canMergeIntoMain(["release/0.2.0"], "fix/release-crash", ["release-fix"])).toBe(true);
  });

  it("fails closed for concurrent releases", () => {
    expect(canMergeIntoMain(["release/0.2.0", "release/0.3.0"], "release/0.2.0", [])).toBe(false);
  });
});

describe("candidate verification", () => {
  const evidence: CandidateEvidence = { version: "0.2.0", repository: "alexshpunt/pi-agent-computer-use", pullRequest: 7, headCommit: "head",
    baseCommit: "base", tree: "tree", runId: 42, sha256: "", sha512: "" };
  const expected = { repository: evidence.repository, pullRequest: 7, runId: 42, headCommit: "head", version: "0.2.0", tree: "tree", parents: ["base"] };

  it("accepts the tested tree squash-merged onto its tested base", () => {
    expect(() => verifyCandidate(evidence, expected)).not.toThrow();
  });

  it("rejects another tree, run or merge shape", () => {
    expect(() => verifyCandidate(evidence, { ...expected, tree: "other" })).toThrow("tree");
    expect(() => verifyCandidate(evidence, { ...expected, runId: 43 })).toThrow("runId");
    expect(() => verifyCandidate(evidence, { ...expected, parents: ["base", "head"] })).toThrow("squash");
    expect(() => verifyCandidate(evidence, { ...expected, parents: ["main"] })).toThrow("squash");
  });

  async function archive(manifest: Record<string, unknown>, name = "pi-agent-computer-use-0.2.0.tgz") {
    const root = await directory(), out = await directory();
    await mkdir(path.join(root, "package"));
    await writeFile(path.join(root, "package/package.json"), JSON.stringify(manifest));
    execFileSync("tar", ["-czf", path.join(out, name), "-C", root, "package"]);
    const bytes = execFileSync("cat", [path.join(out, name)]);
    return { out, sha256: createHash("sha256").update(bytes).digest("hex"), sha512: createHash("sha512").update(bytes).digest("hex") };
  }

  it("accepts the exact archive and its package identity", async () => {
    const { out, sha256, sha512 } = await archive({ name: "pi-agent-computer-use", version: "0.2.0" });
    expect(verifyCandidateArchive(out, { ...evidence, sha256, sha512 })).toBe(path.join(out, "pi-agent-computer-use-0.2.0.tgz"));
    expect(integrity({ sha512 })).toBe(`sha512-${Buffer.from(sha512, "hex").toString("base64")}`);
  });

  it("rejects changed bytes, another package or a private manifest", async () => {
    const good = await archive({ name: "pi-agent-computer-use", version: "0.2.0" });
    expect(() => verifyCandidateArchive(good.out, { ...evidence, sha256: "0".repeat(64), sha512: good.sha512 })).toThrow("sha256");
    const other = await archive({ name: "pi-agent-ide", version: "0.2.0" });
    expect(() => verifyCandidateArchive(other.out, { ...evidence, sha256: other.sha256, sha512: other.sha512 })).toThrow("identity");
    const hidden = await archive({ name: "pi-agent-computer-use", version: "0.2.0", private: true });
    expect(() => verifyCandidateArchive(hidden.out, { ...evidence, sha256: hidden.sha256, sha512: hidden.sha512 })).toThrow("identity");
    const renamed = await archive({ name: "pi-agent-computer-use", version: "0.2.0" }, "pi-agent-computer-use-0.3.0.tgz");
    expect(() => verifyCandidateArchive(renamed.out, { ...evidence, sha256: renamed.sha256, sha512: renamed.sha512 })).toThrow("Unexpected");
  });

  async function installed(manifest: Record<string, unknown>, files: string[]) {
    const dir = await directory(), root = path.join(dir, "node_modules/pi-agent-computer-use");
    for (const file of files) { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), ""); }
    await writeFile(path.join(root, "package.json"), JSON.stringify(manifest));
    return dir;
  }
  const manifest = { name: "pi-agent-computer-use", version: "0.2.0", pi: { extensions: ["./src/index.ts"], skills: ["./skills"] } };

  it("accepts installed Pi entries and skills", async () => {
    const dir = await installed(manifest, ["src/index.ts", "skills/computer-use/SKILL.md"]);
    expect(() => verifyInstalledPackage(dir, "0.2.0")).not.toThrow();
  });

  it("rejects a missing extension entry or an empty skill root", async () => {
    const noEntry = await installed(manifest, ["skills/computer-use/SKILL.md"]);
    const noSkill = await installed(manifest, ["src/index.ts", "skills/README.md"]);
    const complete = await installed(manifest, ["src/index.ts", "skills/computer-use/SKILL.md"]);
    expect(() => verifyInstalledPackage(noEntry, "0.2.0")).toThrow("extension entry");
    expect(() => verifyInstalledPackage(noSkill, "0.2.0")).toThrow("SKILL.md");
    expect(() => verifyInstalledPackage(complete, "0.3.0")).toThrow("identity");
  });
});
