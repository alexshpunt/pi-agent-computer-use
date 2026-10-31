import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PACKAGE_NAME } from "./package.ts";

/** Evidence recorded by the successful release PR validation job. */
export interface CandidateEvidence {
  version: string;
  repository: string;
  pullRequest: number;
  headCommit: string;
  baseCommit: string;
  tree: string;
  runId: number;
  sha256: string;
  sha512: string;
}

export function archiveName(version: string): string {
  return `${PACKAGE_NAME}-${version}.tgz`;
}

export function integrity(evidence: Pick<CandidateEvidence, "sha512">): string {
  return `sha512-${Buffer.from(evidence.sha512, "hex").toString("base64")}`;
}

/** Installs an archive the way `pi install` does: npm, an install prefix and no peer resolution. */
export function installTestPackage(directory: string, archive: string): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, "package.json"), JSON.stringify({ private: true }) + "\n");
  execFileSync("npm", ["install", path.resolve(archive), "--prefix", directory, "--legacy-peer-deps",
    "--registry=https://registry.npmjs.org/"], { stdio: "inherit" });
}

/**
 * Checks the installed package against its Pi manifest: every extension entry exists and every skill root holds
 * at least one SKILL.md. Pi loads the TypeScript entries itself; the installed-package integration test runs them.
 */
export function verifyInstalledPackage(directory: string, version: string): void {
  const root = path.join(directory, "node_modules", PACKAGE_NAME);
  const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
    name?: string; version?: string; pi?: { extensions?: string[]; skills?: string[] };
  };
  if (manifest.name !== PACKAGE_NAME || manifest.version !== version) throw new Error("Installed package identity does not match");
  const extensions = manifest.pi?.extensions ?? [], skills = manifest.pi?.skills ?? [];
  if (!extensions.length) throw new Error("No Pi extension entries");
  for (const entry of extensions) if (!existsSync(path.resolve(root, entry))) throw new Error(`Missing Pi extension entry ${entry}`);
  if (!skills.length) throw new Error("No Pi skill roots");
  for (const skillRoot of skills) {
    const directoryPath = path.resolve(root, skillRoot);
    const found = readdirSync(directoryPath, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && existsSync(path.join(directoryPath, entry.name, "SKILL.md")));
    if (!found.length) throw new Error(`Skill root ${skillRoot} holds no SKILL.md`);
  }
}

/** Rejects promotion unless the tested tree became one squash commit on main. */
export function verifyCandidate(evidence: CandidateEvidence, expected: {
  repository: string; pullRequest: number; runId: number; headCommit: string; version: string; tree: string; parents: string[];
}): void {
  for (const key of ["repository", "pullRequest", "runId", "headCommit", "version", "tree"] as const)
    if (evidence[key] !== expected[key]) throw new Error(`Candidate ${key} does not match`);
  if (expected.parents.length !== 1 || expected.parents[0] !== evidence.baseCommit)
    throw new Error("Candidate was not squash merged onto its tested base");
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(evidence.version)) throw new Error("Invalid release version");
}

/** Checks the exact archive bytes and package identity before they can be published. */
export function verifyCandidateArchive(directory: string, evidence: CandidateEvidence): string {
  const filename = archiveName(evidence.version);
  const archives = readdirSync(directory).filter(name => name.endsWith(".tgz"));
  if (archives.length !== 1 || archives[0] !== filename) throw new Error("Unexpected release archive");
  const file = path.join(directory, filename);
  const bytes = readFileSync(file);
  for (const algorithm of ["sha256", "sha512"] as const)
    if (createHash(algorithm).update(bytes).digest("hex") !== evidence[algorithm]) throw new Error(`Archive ${algorithm} does not match`);
  const manifest = JSON.parse(execFileSync("tar", ["-xOzf", file, "package/package.json"], { encoding: "utf8" })) as {
    name?: string; version?: string; private?: boolean;
  };
  if (manifest.name !== PACKAGE_NAME || manifest.version !== evidence.version || manifest.private === true)
    throw new Error("Archive package identity does not match");
  return file;
}
