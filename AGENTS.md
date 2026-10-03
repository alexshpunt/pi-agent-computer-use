# Working on this project

Read [README.md](README.md) for project intent and [docs/research-references.md](docs/research-references.md) for research inputs. The linked Linear task owns accepted scope and acceptance; reference claims are not requirements.

The current task is [LPT-370](https://linear.app/alexshpunt/issue/LPT-370): an agent-owned visible Windows browser with a disposable profile and private control pipe. Browser tools may use only that owned session, even under YOLO. Desktop YOLO is the default; only the user can change Safe/YOLO. Safe is a UI policy, not OS isolation. [Sandbox work](https://linear.app/alexshpunt/issue/LPT-364) is separate and deferred.

Keep Pi Agent IDE unchanged. The final provider API and migration remain open. Any extraction experiment needs an isolated IDE branch/worktree and verification of both extensions together. Read [the external comparison](docs/research/external-implementations.md) before repeating research.

Ask before broadening platform/backend/app scope, adding permissions, or changing persistent machine setup. Live verification uses only newly created or explicitly authorized disposable Notepad/Calculator windows, or the owned browser on synthetic local pages. Never act on real documents, personal browser data, accounts or external forms. Desktop-wide capability does not authorize unrelated tasks.

Keep reusable material tracked. Use the ignored `.tmp/` directory for disposable artifacts and remove them after durable evidence is captured.
