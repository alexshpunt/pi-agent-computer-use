# Working on this project

Read [README.md](README.md) for project intent and [docs/research-references.md](docs/research-references.md) for research inputs. The linked Linear task owns accepted scope and acceptance; reference claims are not requirements.
Read [the computer-use skill](.pi/skills/computer-use/SKILL.md) before operating UI tools. It describes overview, detail and sequential input through Pi Codemode.

## Unified computer use

Use one window-first `computer_*` tool family for all apps, including browsers. Discover a window, read its native accessibility tree and screenshot, then click or type. Do not create a separate browsing API or bind a browser page, tab or profile to use an ordinary window. `browser_*` tools are temporarily disabled in the production extension; their adapter and standalone profiler remain for research.

In YOLO, existing windows do not need session ownership or a browser grant. Safe still limits access to session-opened windows. Neither mode authorizes unrelated work or bypasses the user's task boundaries.

Use coordinates local to the returned window image. The window's desktop position is not an input coordinate. Moving a window alone should not invalidate a local point; resizing or changing image scale can change its mapping and layout.

Rely on CUA's native identity, targeting and coordinate guarantees first. Add an adapter check only for a demonstrated missing guarantee, not a hypothetical one. Window lifetime is not window geometry. Movement, resizing and scale changes must not invalidate read-only window detail: keep the original local rectangle and native scale, use fresh CUA pixels, clip smaller current bounds and never expand on growth. Position the human mark using current bounds. Keep identity, permissions and cancellation separate; inspect the native contract before adding equivalent checks. Do not move the retired browser binding checks into the common window path.

## Driver-first design

Use Cua Driver as the computer-use foundation. Inspect current upstream docs, source and native capabilities before building an equivalent feature. Use what the driver already provides, then adapt it to our needs.

Prefer the newest upstream release that passes our compatibility checks. When developing features, check recent releases and qualify the selected version on Windows/WSL before explicitly updating its pin. Do not silently auto-update at startup or change persistent machine setup without approval. Stable or prerelease status alone is not proof of compatibility.

Add missing capabilities in our adapter layer when the driver's public API is enough. When a required native capability is missing, the user-approved CUA fork may add it inside the driver. Keep changes focused and keep CUA as the only capture/input backend. Small, focused processing above native CUA output is allowed, such as cropping a full-resolution display capture.

The user has approved a public CUA fork for continuous Windows drawing. First prove that the upstream base builds on Windows, then add a continuous drag path and verify it through the production computer_* tools. The final acceptance is drawing a picture with the brush in a new Paint document, not merely passing a synthetic canvas test. Keep the existing qualified driver until the fork passes compatibility and live checks. Do not silently replace the installed runtime or change persistent machine setup.

Do not restore the retired Playwright browser, Sharp image engine, saved-original crop pipeline or stable-DOM hint registry as a fallback. A focused crop/resize dependency may serve an approved adapter feature; it must not become another browser or capture engine. Keep source identity, coordinate domains, permissions and freshness limits explicit. An adapter must not bypass ownership or Safe mode, or silently fall back to a wider source.

## Human-only overlays

Prefer a small Qt helper for on-screen observation and crop frames; Qt is a candidate, not an adopted dependency. Keep CUA as the only capture/input backend. Before adopting Qt, measure its deployment, startup and memory costs, review licensing, and verify click-through, focus behavior and capture exclusion on each target platform. Do not claim cross-platform support without live checks. [Qt overlay research](https://linear.app/alexshpunt/issue/LPT-408) is separate from model-facing image annotations.

## Access and scope

The retained browser research adapter stays within its owned session, even under YOLO; it is not registered as agent tooling. Desktop YOLO is the default; only the user can change Safe/YOLO. Safe is a UI policy, not OS isolation. LPT-372 and its game are paused; its unfinished old-backend patch is archived in Linear. [Sandbox work](https://linear.app/alexshpunt/issue/LPT-364) is separate and deferred.

Keep Pi Agent IDE unchanged. The final provider API and migration remain open. Any extraction experiment needs an isolated IDE branch/worktree and verification of both extensions together. Read [the external comparison](docs/research/external-implementations.md) before repeating research.

Ask before broadening platform/backend/app scope, adding permissions, or changing persistent machine setup. Live verification uses only newly created or explicitly authorized disposable Notepad/Calculator windows, new Paint documents for the approved drawing work, or the owned browser on synthetic local pages. Never act on real documents, personal browser data, accounts or external forms. Desktop-wide capability does not authorize unrelated tasks.

Keep reusable material tracked. Use the ignored `.tmp/` directory for disposable artifacts and remove them after durable evidence is captured.
