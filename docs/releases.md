# Develop and release Pi Agent Computer Use

Feature branches merge into `develop`. Ready changes merge into `main` through a pinned promotion PR. A versioned release starts from `main` and freezes it until the package is published and `main` has been merged back into `develop`, or the unpublished release is canceled. `develop` stays open throughout. The flow follows [Pi Agent IDE](https://github.com/alexshpunt/pi-agent-ide/blob/main/docs/releases.md), adapted to npm and one package.

## Workflows

| Workflow | Trigger | What it does |
| --- | --- | --- |
| CI (`ci.yml`) | Push and PR | The `Validate` job runs typecheck, unit and integration tests. On a PR to `main` it enforces the release freeze. On a release PR it also builds the candidate archive. |
| Start release (`release-start.yml`) | Manual, on `main` | Creates `release/X.Y.Z` with the version and changelog section, then opens its PR to `main`. |
| Publish to npm (`release.yml`) | Manual, on `main` | Verifies the merged release PR and its candidate run, publishes that exact archive after approval, tags it and creates the GitHub release, then synchronizes `develop`. |
| Cancel release (`release-cancel.yml`) | Manual, on `main` | Closes an unpublished release PR and deletes its branch. |
| Synchronize main into develop (`sync-develop.yml`) | Push to `main` | Merges `main` into `develop` unless a release is active. |

The scripts behind them live in `scripts/release/`.

## Promote to main

Choose the release cut by its full `develop` commit SHA. Create a branch such as `chore/promote-X.Y.Z` from that commit and open its PR to `main`. Keep the branch unchanged while CI runs, then squash-merge it. Check that **Synchronize main into develop** succeeds before starting the release. Squash merges make the histories of `main` and `develop` diverge, so a failed synchronization must be fixed before the next promotion.

## Start a release

Run **Start release** on `main` with an unused `X.Y.Z` and finished release notes. It refuses a version that npm already has, an existing tag and a second active release. It sets the version in `package.json` and `package-lock.json`, adds `## X.Y.Z — date` with the notes to `CHANGELOG.md` and opens the release PR.

A branch named exactly `release/X.Y.Z` is the freeze marker. While it exists, the `Validate` check rejects every PR to `main` except the release PR and `fix/release-*` PRs labeled `release-fix`. Review the fix itself: the label is not proof that a change is a fix. After a fix merges into `main`, rebase the release branch onto it with `--force-with-lease` and wait for a new candidate run.

## Release candidate

CI on the release PR runs the normal checks, then `scripts/release/build-candidate.ts`:

1. Packs the package twice with `npm pack` (prepack fetches and hash-checks the pinned native runtime) and fails if the archives differ.
2. Installs the archive the way `pi install` does: `npm install <archive> --prefix <root> --legacy-peer-deps`.
3. Checks the installed manifest: every `pi.extensions` entry exists and every `pi.skills` root holds a skill.
4. Runs `test/installed-package.integration.test.ts` against that install in real Pi, standalone and with the installed Pi Agent IDE.
5. Records the PR, head, tested base, tree, run and archive hashes in `candidate.json` and keeps both files as the `release-candidate` artifact.

To rehearse packing and installation locally, run `node scripts/release/build-candidate.ts --local`. A local candidate is never published.

Squash-merge only a release PR whose candidate passed. Keep the release branch until publication and synchronization finish.

## Publish

Run **Publish to npm** on `main` with the merged release PR number and the ID of its successful CI run. With `publish: false` it only verifies: the PR merged from `release/X.Y.Z`, the run is CI for that PR head, the squash commit has the tested tree on the tested base, `main` has not moved except for release infrastructure, and the downloaded archive matches the recorded hashes. With `publish: true` it then waits for approval of the protected `npm` environment and publishes the downloaded bytes with `npm publish --provenance` through npm Trusted Publishing. It never rebuilds the archive. A retry cannot replace a tag or publish different bytes under an existing version.

After publication the finish job waits until the registry serves the version, compares its integrity with the candidate, merges `main` into `develop` and deletes the unchanged release branch. If `develop` moved during the push or the merge conflicts, the branch stays and `main` stays frozen. Resolve the conflict and rerun the same publication.

To abandon an unpublished release, run **Cancel release** with the version and the confirmation `cancel`. If its PR already merged, revert it on `main` first. A published or tagged version cannot be canceled.

## One-time setup

The repository owner configures these before the first release:

- Make the repository public and create `main` from the commit chosen for 0.1.0.
- Protect `main`: no direct pushes, PRs require the `Validate` check.
- Install a GitHub App on this repository with Contents and Pull requests write access. Store its ID and private key as the Actions secrets `RELEASE_APP_ID` and `RELEASE_APP_PRIVATE_KEY`. The App pushes release branches, `develop` merges and branch deletions.
- Create the `npm` Actions environment with required reviewers.
- Create the `release-fix` label.

### Publish the first version

npm cannot attach a Trusted Publisher to a package that does not exist yet, so 0.1.0 goes through the normal candidate flow and is then published by hand from the verified archive:

1. Run **Start release** with `0.1.0` and its notes, wait for the candidate run and squash-merge the release PR.
2. Run **Publish to npm** with `publish: false`. It keeps the verified archive as the `release-0.1.0` artifact.
3. Download that artifact (`gh run download <run> --name release-0.1.0`), check that `sha512` in `candidate.json` matches the archive, and publish it: `npm publish pi-agent-computer-use-0.1.0.tgz --access public`.
4. Attach the Trusted Publisher: `npm trust github pi-agent-computer-use --repo alexshpunt/pi-agent-computer-use --file release.yml --env npm` (npm 11.10 or newer). A new relationship expires if no trusted publish succeeds within two days, so later versions should follow soon or the relationship is recreated.
5. Run **Publish to npm** again with `publish: true` and the same PR and run. It finds 0.1.0 in the registry with the candidate's integrity, creates the `v0.1.0` tag and GitHub release, and synchronizes `develop`.

Every later version publishes through the workflow.
