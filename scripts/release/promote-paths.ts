/** Files that may change on main after the candidate merged without invalidating it. */
export const RELEASE_INFRASTRUCTURE_PATHS: ReadonlySet<string> = new Set([
  ".github/workflows/release.yml",
  "scripts/release/promote.ts",
  "scripts/release/promote-paths.ts",
  "scripts/release/publish.ts",
]);
