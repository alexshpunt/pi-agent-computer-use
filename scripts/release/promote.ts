import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { verifyCandidate, verifyCandidateArchive, type CandidateEvidence } from "./candidate.ts";
import { PROMOTED_DIRECTORY, REPOSITORY } from "./package.ts";
import { RELEASE_INFRASTRUCTURE_PATHS } from "./promote-paths.ts";

const pr = Number(process.env.RELEASE_PR);
const runId = Number(process.env.CANDIDATE_RUN);
if (!Number.isSafeInteger(pr) || pr <= 0 || !Number.isSafeInteger(runId) || runId <= 0)
  throw new Error("A merged PR and successful candidate run are required");
const api = (route: string): unknown => JSON.parse(execFileSync("gh", ["api", `repos/${REPOSITORY}/${route}`], { encoding: "utf8" }));
const pull = api(`pulls/${pr}`) as { merged: boolean; base: { ref: string }; head: { sha: string; ref: string; repo: { full_name: string } | null }; merge_commit_sha: string };
const run = api(`actions/runs/${runId}`) as { conclusion: string; event: string; workflow_id: number; head_sha: string; head_repository: { full_name: string } | null };
const workflow = api("actions/workflows/ci.yml") as { id: number };
if (!pull.merged || pull.base.ref !== "main" || pull.head.repo?.full_name !== REPOSITORY || !/^release\/\d+\.\d+\.\d+$/.test(pull.head.ref))
  throw new Error("Only a merged same-repository release PR into main can be promoted");
if (run.conclusion !== "success" || run.event !== "pull_request" || run.workflow_id !== workflow.id ||
  run.head_sha !== pull.head.sha || run.head_repository?.full_name !== REPOSITORY)
  throw new Error("Candidate run is not successful CI for this PR head");
const commit = api(`git/commits/${pull.merge_commit_sha}`) as { tree: { sha: string }; parents: { sha: string }[] };
const main = api("git/ref/heads/main") as { object: { sha: string } };
if (main.object.sha !== pull.merge_commit_sha) {
  const comparison = api(`compare/${pull.merge_commit_sha}...${main.object.sha}`) as { status: string; files?: { filename: string }[] };
  if (comparison.status !== "ahead" || !comparison.files?.length || comparison.files.some(({ filename }) => !RELEASE_INFRASTRUCTURE_PATHS.has(filename)))
    throw new Error("Release candidate is no longer the current publishable main tree");
}
const manifestFile = api(`contents/package.json?ref=${pull.merge_commit_sha}`) as { content: string };
const manifest = JSON.parse(Buffer.from(manifestFile.content, "base64").toString("utf8")) as { version: string };
if (pull.head.ref !== `release/${manifest.version}`) throw new Error("Merged release branch and package version differ");
mkdirSync(PROMOTED_DIRECTORY, { recursive: true });
execFileSync("gh", ["run", "download", String(runId), "--repo", REPOSITORY, "--name", "release-candidate", "--dir", PROMOTED_DIRECTORY], { stdio: "inherit" });
const evidence = JSON.parse(readFileSync(`${PROMOTED_DIRECTORY}/candidate.json`, "utf8")) as CandidateEvidence;
verifyCandidate(evidence, { repository: REPOSITORY, pullRequest: pr, runId, headCommit: pull.head.sha, version: manifest.version,
  tree: commit.tree.sha, parents: commit.parents.map(parent => parent.sha) });
verifyCandidateArchive(PROMOTED_DIRECTORY, evidence);
writeFileSync(`${PROMOTED_DIRECTORY}/promotion.json`, JSON.stringify({ commit: pull.merge_commit_sha, runId, pr, version: evidence.version }) + "\n");
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `version=${evidence.version}\ncommit=${pull.merge_commit_sha}\n`);
