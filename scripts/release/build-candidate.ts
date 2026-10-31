import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { archiveName, installTestPackage, verifyInstalledPackage, type CandidateEvidence } from "./candidate.ts";
import { CANDIDATE_DIRECTORY } from "./package.ts";

/** Packs the package with npm, which runs prepack and fetches the pinned native runtime. */
function pack(destination: string, filename: string): Buffer {
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true });
  // prepack logs to stdout, so the archive is found by its name rather than by parsing npm's output.
  execFileSync("npm", ["pack", "--pack-destination", destination], { stdio: "inherit" });
  return readFileSync(path.join(destination, filename));
}

const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" }).trim();
const { version } = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
const local = process.argv.includes("--local");
let identity: Omit<CandidateEvidence, "version" | "sha256" | "sha512" | "baseCommit" | "tree">;
if (local) {
  // A local rehearsal checks packing and installation; its evidence never reaches Publish.
  identity = { repository: "local", pullRequest: 0, headCommit: git("rev-parse", "HEAD"), runId: 0 };
} else {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) throw new Error("Missing GitHub event");
  const pr = (JSON.parse(readFileSync(eventPath, "utf8")) as {
    pull_request?: { number: number; base: { ref: string }; head: { sha: string; ref: string; repo: { full_name: string } } };
  }).pull_request;
  if (!pr || pr.head.repo.full_name !== process.env.GITHUB_REPOSITORY) throw new Error("Expected a same-repository PR");
  if (pr.base.ref !== "main") throw new Error("Release candidate must target main");
  if (pr.head.ref !== `release/${version}`) throw new Error("Release branch and package version differ");
  identity = { repository: pr.head.repo.full_name, pullRequest: pr.number, headCommit: pr.head.sha, runId: Number(process.env.GITHUB_RUN_ID) };
}

mkdirSync(".tmp", { recursive: true });
const work = mkdtempSync(path.resolve(".tmp/release-build-"));
try {
  const filename = archiveName(version);
  const first = pack(path.join(work, "first"), filename);
  const second = pack(path.join(work, "second"), filename);
  if (!first.equals(second)) throw new Error("Release archive is not reproducible");
  rmSync(CANDIDATE_DIRECTORY, { recursive: true, force: true });
  mkdirSync(CANDIDATE_DIRECTORY, { recursive: true });
  copyFileSync(path.join(work, "second", filename), path.join(CANDIDATE_DIRECTORY, filename));
  const installation = path.resolve(".tmp/release-install");
  rmSync(installation, { recursive: true, force: true });
  installTestPackage(installation, path.join(CANDIDATE_DIRECTORY, filename));
  verifyInstalledPackage(installation, version);
  execFileSync("npx", ["pi-test", "run", "--", "vitest", "run", "--config", "vitest.integration.config.ts",
    "test/installed-package.integration.test.ts"], {
    stdio: "inherit", env: { ...process.env, PI_COMPUTER_USE_TEST_INSTALLATION: installation },
  });
  const evidence: CandidateEvidence = {
    version, ...identity,
    // CI checks out the PR merge commit: its first parent is the tested main base.
    baseCommit: local ? git("rev-parse", "HEAD") : git("rev-parse", "HEAD^1"),
    tree: git("rev-parse", "HEAD^{tree}"),
    sha256: createHash("sha256").update(second).digest("hex"),
    sha512: createHash("sha512").update(second).digest("hex"),
  };
  writeFileSync(path.join(CANDIDATE_DIRECTORY, "candidate.json"), JSON.stringify(evidence, null, 2) + "\n");
  console.log(`Candidate ${filename} ${evidence.sha256}`);
} finally { rmSync(work, { recursive: true, force: true }); }
