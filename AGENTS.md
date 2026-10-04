# Working on this project

Read [README.md](README.md) for project intent and [docs/research-references.md](docs/research-references.md) for research inputs. The linked Linear task owns accepted scope and acceptance; reference claims are not requirements.
Read [the owned-browser-use skill](skills/owned-browser-use/SKILL.md) before operating browser tools. It describes image-first native CUA interaction, snapshot-scoped hints and batching in Pi Codemode.

The current task is [LPT-396](https://linear.app/alexshpunt/issue/LPT-396): CUA-only owned-browser input, native vision and a human-visible agent cursor. LPT-372 and its game are paused; its unfinished old-backend patch is archived in Linear. Do not revive Playwright, Sharp, saved-original crops or a stable-DOM hint registry as a fallback. Browser tools may use only that owned session, even under YOLO. Desktop YOLO is the default; only the user can change Safe/YOLO. Safe is a UI policy, not OS isolation. [Sandbox work](https://linear.app/alexshpunt/issue/LPT-364) is separate and deferred.

Keep Pi Agent IDE unchanged. The final provider API and migration remain open. Any extraction experiment needs an isolated IDE branch/worktree and verification of both extensions together. Read [the external comparison](docs/research/external-implementations.md) before repeating research.

Ask before broadening platform/backend/app scope, adding permissions, or changing persistent machine setup. Live verification uses only newly created or explicitly authorized disposable Notepad/Calculator windows, or the owned browser on synthetic local pages. Never act on real documents, personal browser data, accounts or external forms. Desktop-wide capability does not authorize unrelated tasks.

Keep reusable material tracked. Use the ignored `.tmp/` directory for disposable artifacts and remove them after durable evidence is captured.
