# Working on this project

Read [README.md](README.md) for project intent and [docs/research-references.md](docs/research-references.md) for research inputs. The linked Linear task owns accepted scope and acceptance; reference claims are not requirements.
Read [the computer-use skill](.pi/skills/computer-use/SKILL.md) before operating UI tools. It describes native Read/Search, literal Write and snapshot-bound JSON Insert. Codemode composition is optional.
Before changing or verifying this extension in a worktree, read [the development skill](.pi/skills/develop-computer-use/SKILL.md). Use the worktree's code only for the task session, then restore global loading.

## Unified computer use

Expose one window-first computer provider through ordinary IDE Read/Search/Write/Insert for all apps, including browsers. Keep only the visual classifier as a separate computer tool. Discover a window, read its native accessibility tree and screenshot, then click or type. Browser pages go through the same resources, not a separate browsing tool. Native interaction with a browser window never requires a Playwright binding.

Use a specialized system for each job: CUA for any UI interaction, Playwright for any browser. Playwright owns page structure, locators, actions, waiting, frames and page/element screenshots in every browser the agent works with: browsers the session opens and existing browsers, including the user's own browser and profile when the user shares them. CUA owns windows, the browser's own toolbar/tabs/menus, system dialogs and native capture/input, and stays available for clicks, drags and other direct input in any window, browsers included. Do not reimplement what Playwright already provides, and do not add project-owned browser-version or DPR allowlists. (The earlier ban on attaching Playwright to personal browsers dates from the CUA-only design; the owner lifted it.)

In YOLO, existing windows do not need session ownership or a browser grant. Safe still limits access to session-opened windows. Neither mode authorizes unrelated work or bypasses the user's task boundaries.

Use coordinates local to the returned window image. The window's desktop position is not an input coordinate. Moving a window alone should not invalidate a local point; resizing or changing image scale can change its mapping and layout.

Rely on CUA's native identity, targeting and coordinate guarantees first. Add an adapter check only for a demonstrated missing guarantee, not a hypothetical one. Window lifetime is not window geometry. Movement, resizing and scale changes must not invalidate read-only window detail: keep the original local rectangle and native scale, use fresh CUA pixels, clip smaller current bounds and never expand on growth. Position the human mark using current bounds. Keep identity, permissions and cancellation separate; inspect the native contract before adding equivalent checks. Do not move the retired browser binding checks into the common window path.

## Driver-first design

Always install and activate each newly qualified driver in the normal Pi configuration before declaring its task complete. Treat CI and temporary candidate sessions as verification, not deployment. Keep the previous driver for rollback, announce the switch, and verify that the normal session uses the new source, hash and profile. The owner has given standing approval for this qualified-runtime adoption; do not ask again. Keep automatic startup updates, broader platform/backend scope, new permissions and unrelated machine setup outside this approval.

Use Cua Driver as the computer-use foundation. Inspect current upstream docs, source and native capabilities before building an equivalent feature. Use what the driver already provides, then adapt it to our needs.

Prefer the newest upstream release that passes our compatibility checks. When developing features, check recent releases and qualify the selected version on Windows/WSL before explicitly updating its pin. Do not silently auto-update at startup or change persistent machine setup without approval. Stable or prerelease status alone is not proof of compatibility.

Add missing capabilities in our adapter layer when the driver's public API is enough. When a required native capability is missing, add it inside the user-approved CUA fork. The owner permits focused fork changes needed for accepted tasks in this project without a separate confirmation for each native capability. This does not approve broader platform/backend/app scope, new permissions or unrelated machine setup changes; those still need approval. Adopt qualified runtimes under the standing approval above. Keep changes focused and keep CUA as the only native capture/input backend. Small, focused processing above native CUA output is allowed, such as cropping a full-resolution display capture.

The user has approved a public CUA fork for continuous Windows drawing. First prove that the upstream base builds on Windows, then add a continuous drag path and verify it through the production computer provider. The final acceptance is drawing a picture with the brush in a new Paint document, not merely passing a synthetic canvas test. Keep the existing qualified driver until the fork passes compatibility and live checks. Do not silently replace the installed runtime or change persistent machine setup.

Do not restore the retired Sharp image engine, saved-original crop pipeline or stable-DOM hint registry, and do not add a fallback between Playwright and CUA. A focused crop/resize dependency may serve an approved adapter feature; it must not become another capture engine. Keep source identity, coordinate domains, permissions and freshness limits explicit. An adapter must not bypass ownership or Safe mode, or silently fall back to a wider source.

## Human-only overlays

Prefer a small Qt helper for on-screen observation and crop frames; Qt is a candidate, not an adopted dependency. Keep CUA as the only native capture/input backend. Before adopting Qt, measure its deployment, startup and memory costs, review licensing, and verify click-through, focus behavior and capture exclusion on each target platform. Do not claim cross-platform support without live checks. [Qt overlay research](https://linear.app/alexshpunt/issue/LPT-408) is separate from model-facing image annotations.

## Access and scope

Current work covers only Windows controlled from WSL, including browser work: the local host, or another Windows machine with WSL reached over SSH ([LPT-791](https://linear.app/alexshpunt/issue/LPT-791)). Remote machines come only from trusted `machines` configuration, run their helpers as SSH children and open no ports. Other desktop platforms are not approved or verified, and we have no environment to test them. Do not turn their qualification into current feature acceptance or claim support there. Keep platform limits explicit; any later expansion needs a separate owner decision.

In YOLO, Playwright may attach to existing browsers the user shares, including their personal profile; Safe limits Playwright to browsers the session opened. Desktop YOLO is the default; only the user can change Safe/YOLO. Safe is a UI policy, not OS isolation. LPT-372 and its game are paused; its unfinished old-backend patch is archived in Linear. Windows Sandbox ([LPT-621](https://linear.app/alexshpunt/issue/LPT-621)) gives agents a disposable Windows environment for non-interference with the human's desktop; it is not a security boundary. A separate Linux desktop in WSL (LPT-622/623) was canceled; isolated agent sessions (LPT-630) let several agents work on one machine.

Use IDE's public provider SDK. Computer-specific capture, policy and input belong here, never in IDE. If a demonstrated gap needs a generic public SDK extension, use an isolated IDE branch/worktree and verify both extensions together. Pi core stays read-only. Standalone computer-use checks must not inherit an unrelated latest/clean-IDE gate. Read [the external comparison](docs/research/external-implementations.md) before repeating research.

Ask before broadening platform/backend/app scope, adding permissions, or changing persistent machine setup. Live verification uses only newly created or explicitly authorized disposable Notepad/Calculator windows, new Paint documents for the approved drawing work, owned or check-started browsers on synthetic local pages, or apps inside a session-opened Windows Sandbox or isolated session. Checks of attaching to an existing browser start that browser themselves; they never use the human's own browser. The same limits apply on a remote machine. Never act on real documents, personal browser data, accounts or external forms. Desktop-wide capability does not authorize unrelated tasks.

Keep reusable material tracked. Use the ignored `.tmp/` directory for disposable artifacts and remove them after durable evidence is captured.
