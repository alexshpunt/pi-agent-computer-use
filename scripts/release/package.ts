/** Identity of the only package this repository releases. */
export const PACKAGE_NAME = "pi-agent-computer-use";
export const REPOSITORY = "alexshpunt/pi-agent-computer-use";
export const REPOSITORY_OWNER = "alexshpunt";
/** Where CI keeps the candidate and Publish keeps the downloaded, verified candidate. */
export const CANDIDATE_DIRECTORY = ".tmp/release/candidate";
export const PROMOTED_DIRECTORY = ".tmp/release/promoted";
export const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

export function registryUrl(version: string): string {
  return `https://registry.npmjs.org/${PACKAGE_NAME}/${version}`;
}
