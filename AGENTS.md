# Working on this project

Read [README.md](README.md) for project intent and [docs/research-references.md](docs/research-references.md) for future research inputs. Use the linked Linear task for accepted scope and acceptance; do not treat reference claims as requirements.

The current work is a standalone Cua Driver proof of concept, defined in [LPT-356](https://linear.app/alexshpunt/issue/LPT-356/prove-standalone-windows-computer-use-from-pi-in-wsl). It uses its own tools without Pi Agent IDE. Keep the working IDE unchanged. Read [the external comparison](docs/research/external-implementations.md) before repeating research. The final provider API and migration remain open. Ask before broadening the backend/platform/app scope, changing permissions, or adding persistent machine setup. Live desktop work is limited to an owned empty Notepad document; never act on existing documents. Future extraction experiments still need an isolated IDE branch/worktree and verification of both extensions together.

Keep reusable project material tracked. Use the ignored `.tmp/` directory for disposable files and remove them when finished.
