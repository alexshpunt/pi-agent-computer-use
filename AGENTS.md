# Working on this project

Read [README.md](README.md) for project intent and [docs/research-references.md](docs/research-references.md) for research inputs. The linked Linear task owns accepted scope and acceptance; reference claims are not requirements.
Read [the owned-browser-use skill](skills/owned-browser-use/SKILL.md) before operating browser tools. It describes image-first native CUA interaction, snapshot-scoped hints and batching in Pi Codemode.

## Driver-first design

Use Cua Driver as the computer-use foundation. Inspect current upstream docs, source and native capabilities before building an equivalent feature. Use what the driver already provides, then adapt it to our needs.

Prefer the newest upstream release that passes our compatibility checks. When developing features, check recent releases and qualify the selected version on Windows/WSL before explicitly updating its pin. Do not silently auto-update at startup or change persistent machine setup without approval. Stable or prerelease status alone is not proof of compatibility.

Add missing capabilities in our adapter layer between Pi and the unmodified driver. Do not patch or fork CUA, or add another capture/input backend to fill a gap. Small, focused processing above native CUA output is allowed, such as cropping a full-resolution display capture. This is a design direction, not a claim that every adapter feature exists already.

Do not restore the retired Playwright browser, Sharp image engine, saved-original crop pipeline or stable-DOM hint registry as a fallback. A focused crop/resize dependency may serve an approved adapter feature; it must not become another browser or capture engine. Keep source identity, coordinate domains, permissions and freshness limits explicit. An adapter must not bypass ownership or Safe mode, or silently fall back to a wider source.

## Access and scope

Browser tools may use only their owned session, even under YOLO. Desktop YOLO is the default; only the user can change Safe/YOLO. Safe is a UI policy, not OS isolation. LPT-372 and its game are paused; its unfinished old-backend patch is archived in Linear. [Sandbox work](https://linear.app/alexshpunt/issue/LPT-364) is separate and deferred.

Keep Pi Agent IDE unchanged. The final provider API and migration remain open. Any extraction experiment needs an isolated IDE branch/worktree and verification of both extensions together. Read [the external comparison](docs/research/external-implementations.md) before repeating research.

Ask before broadening platform/backend/app scope, adding permissions, or changing persistent machine setup. Live verification uses only newly created or explicitly authorized disposable Notepad/Calculator windows, or the owned browser on synthetic local pages. Never act on real documents, personal browser data, accounts or external forms. Desktop-wide capability does not authorize unrelated tasks.

Keep reusable material tracked. Use the ignored `.tmp/` directory for disposable artifacts and remove them after durable evidence is captured.
