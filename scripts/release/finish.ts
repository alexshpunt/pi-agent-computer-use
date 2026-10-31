import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { integrity, verifyCandidateArchive, type CandidateEvidence } from "./candidate.ts";
import { PROMOTED_DIRECTORY, registryUrl } from "./package.ts";
import { synchronizeDevelop } from "./sync-develop.ts";

const evidence = JSON.parse(readFileSync(`${PROMOTED_DIRECTORY}/candidate.json`, "utf8")) as CandidateEvidence;
const version = process.env.RELEASE_VERSION;
if (version !== evidence.version || process.env.GITHUB_REF !== "refs/heads/main") throw new Error("Finish requires the verified release version on main");
verifyCandidateArchive(PROMOTED_DIRECTORY, evidence);

/** npm accepts a publish minutes before the registry serves the version; wait, but keep main frozen if it never appears. */
async function publishedVersion(): Promise<Response> {
  const deadline = Date.now() + 15 * 60_000;
  for (;;) {
    const response = await fetch(registryUrl(version!));
    if (response.status !== 404 || Date.now() > deadline) return response;
    await sleep(20_000);
  }
}
const registry = await publishedVersion();
if (!registry.ok) throw new Error("Package has not been published; main remains frozen");
const published = await registry.json() as { dist?: { integrity?: string } };
if (published.dist?.integrity !== integrity(evidence)) throw new Error("Registry archive differs from the verified release candidate");
const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" }).trim();
const branch = `refs/heads/release/${version}`;
const branchHead = git("ls-remote", "origin", branch).split("\t")[0];
if (branchHead !== evidence.headCommit) throw new Error("Release branch changed after candidate validation; do not lift the freeze");
synchronizeDevelop();
execFileSync("git", ["push", `--force-with-lease=${branch}:${branchHead}`, "origin", `:${branch}`], { stdio: "inherit" });
