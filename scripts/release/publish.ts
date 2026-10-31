import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { integrity, verifyCandidateArchive, type CandidateEvidence } from "./candidate.ts";
import { PACKAGE_NAME, PROMOTED_DIRECTORY, registryUrl, REPOSITORY } from "./package.ts";
import { RELEASE_INFRASTRUCTURE_PATHS } from "./promote-paths.ts";

const evidence = JSON.parse(readFileSync(`${PROMOTED_DIRECTORY}/candidate.json`, "utf8")) as CandidateEvidence;
const promotion = JSON.parse(readFileSync(`${PROMOTED_DIRECTORY}/promotion.json`, "utf8")) as { version: string; commit: string };
const version = process.env.RELEASE_VERSION;
const commit = process.env.RELEASE_COMMIT;
if (!version || !commit || version !== evidence.version || version !== promotion.version || commit !== promotion.commit || evidence.repository !== REPOSITORY)
  throw new Error("Promotion identity changed");
const archive = verifyCandidateArchive(PROMOTED_DIRECTORY, evidence);

type TagRequest = { tag: string; message: string; object: string; type: "commit" } | { ref: string; sha: string };
async function github(route: string, body?: TagRequest, allowMissing = false) {
  const response = await fetch(`https://api.github.com/repos/${REPOSITORY}/${route}`, {
    method: body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: "application/vnd.github+json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (allowMissing && response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub ${route}: ${response.status}`);
  return await response.json() as { object: { sha: string; type: string }; sha: string; status?: string; files?: { filename: string }[] };
}
const main = await github("git/ref/heads/main");
if (main?.object.sha !== commit) {
  const comparison = await github(`compare/${commit}...${main?.object.sha}`);
  if (comparison?.status !== "ahead" || !comparison.files?.length || comparison.files.some(({ filename }) => !RELEASE_INFRASTRUCTURE_PATHS.has(filename)))
    throw new Error("Main changed while waiting for approval");
}
const tag = `v${version}`;
const existing = await github(`git/ref/tags/${tag}`, undefined, true);
if (existing) {
  if (existing.object.type !== "tag") throw new Error("Release tag must be annotated");
  const annotation = await github(`git/tags/${existing.object.sha}`);
  if (annotation?.object.type !== "commit" || annotation.object.sha !== commit) throw new Error("Existing tag points elsewhere");
}
async function createTag(): Promise<void> {
  const annotation = await github("git/tags", { tag, message: `${PACKAGE_NAME} ${tag}`, object: commit!, type: "commit" });
  if (!annotation) throw new Error("Tag creation returned no object");
  await github("git/refs", { ref: `refs/tags/${tag}`, sha: annotation.sha });
}
const registry = await fetch(registryUrl(version));
if (registry.ok) {
  const published = await registry.json() as { dist?: { integrity?: string } };
  if (published.dist?.integrity !== integrity(evidence)) throw new Error("Version already exists with different release evidence");
  // The first version is published by hand from this verified archive before Trusted Publishing exists.
  if (!existing) await createTag();
  console.log(`${PACKAGE_NAME}@${version} is already published with this exact archive`);
} else {
  if (registry.status !== 404) throw new Error(`Registry check failed: ${registry.status}`);
  if (!existing) await createTag();
  execFileSync("npm", ["publish", archive, "--access", "public", "--provenance"], { stdio: "inherit" });
}
