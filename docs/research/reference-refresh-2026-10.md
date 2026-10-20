# Reference refresh, October 2026

Checked on 2026-10-20 for [LPT-822](https://linear.app/alexshpunt/issue/LPT-822). It updates the [2026-10-02 source comparison](external-implementations.md) and the [Codex notes](codex-computer-use.md), and adds references that did not exist or were not reviewed then. This pass read changelogs, release lists, npm metadata, READMEs, official docs and the locally installed Codex plugin cache. It did not install or run any reference. Numbers that come only from vendors or third-party trackers are marked as not verified.

The project's own state at this date: CUA fork on upstream 0.34.0 (`4379acbd`) plus the M7 branch with `input_timeline`, Playwright `playwright-core` 1.64.1, and the M4–M7 features listed in [computer resources](../computer-resources.md) and the [driver tool audit](driver-tool-audit.md).

## Pinned versions

| Reference | Version or commit now | Link | Change since 2026-10-02 |
| --- | --- | --- | --- |
| Cua Driver (upstream) | `cua-driver-rs-v0.36.0`, pre-release, 2026-10-16; latest stable 0.35.4 (2026-10-14); `main` at `0188c96e` | [CHANGELOG](https://github.com/trycua/cua/blob/cua-driver-rs-v0.36.0/libs/cua-driver/rust/CHANGELOG.md) | 0.35.0 (2026-10-12) is breaking: `get_window_state` returns lean markdown by default and needs `full_output: true` for `elements`. Adds `run_steps` (batched steps with find/wait/check by name), `run_script` (sandboxed QuickJS over the driver's own tools, on by default), `get_window_state` `since: <snapshot_id>` diffs and `display_only`. 0.36.0 says why a Windows desktop cannot be captured (locked, RDP disconnected) and resolves `launch_app` to the app window instead of a launcher splash. Many other fixes are macOS or Linux only. |
| Codex Computer Use (Windows plugin) | Bundle `26.1013.40934` in the local plugin cache (was `26.930.31730`); CLI `rust-v0.164.0-alpha.6`, npm `@openai/codex` 0.163.0 | [openai/codex](https://github.com/openai/codex) | `SKILL.md` and `docs/guidance.md` have the same SHA-256 as before. The bundle also has `docs/api.md` (the `@oai/sky` window API) and `docs/confirmations.md` (a policy that sorts Windows UI actions into hand-off, always-confirm, pre-approvable and free). Whether these two files are new or were simply not read on 2026-10-03 is not verified. |
| Anthropic computer use | `computer_toolset_20260801`, generally available since 2026-08 per search summary; `computer_20251124` still accepted with its beta header | [Computer use tool docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool) | Verified in the docs: one toolset entry gives 17 member tools including `zoom`, needs no beta header, and supports batch actions (several tool calls per turn, run in order). The exact GA date is not verified. |
| `@injaneity/pi-computer-use` | npm 0.5.1 (unchanged); `main` at `67e9e2f7` | [GitHub](https://github.com/injaneity/pi-computer-use) | Unreleased on `main`: compact `observe_ui` output by default, a Windows fallback for uniform (blank) window captures, a macOS activity glow, a docs site. |
| `@amaster.ai/pi-computer-use` | npm 0.1.28 (2026-10-16); `main` at `3807e976` | [GitHub](https://github.com/TGYD-helige/pi/tree/main/packages/pi-computer-use) | Bundled Cua Driver moved from 0.28.2 to 0.35.4. Installs the optional perception packages (`parse_visual_regions`) by default; structured tool results and native tool discovery. |
| `@husain-zaidi/pi-computer-use` | `848f141c` (unchanged); npm still E404 | [GitHub](https://github.com/husain-zaidi/pi-computer-use) | None. |
| `@edward40/pi-computer-use` | npm 0.1.1, `1c56ea3f` (unchanged) | [GitHub](https://github.com/SASUKE40/pi-computer-use) | None. |
| `@agimon-ai/doompi-computer-use` | npm `0.0.1-alpha.72` (2026-10-11) | [npm](https://www.npmjs.com/package/@agimon-ai/doompi-computer-use) | 21 alpha releases since alpha.51. Contents not inspected. |
| pi-browser (larsderidder) | `32b5baaf` (unchanged) | [GitHub](https://github.com/larsderidder/pi-browser) | None in the repository. The npm `pi-browser` 0.1.0 has no repository field, so its identity with this repo is not verified. |
| pi-browser-use | npm 0.12.13 (2026-10-08), `6ba833cc` | [GitHub](https://github.com/0xPlayerOne/pi-browser-use) | Runtime and Pi compatibility upgrades only. |
| pi-agent-browser-native | npm 0.9.6 (2026-10-14), `b64176b3` | [GitHub](https://github.com/fitchmultz/pi-agent-browser-native) | Patch releases: journal continuation and session-name fixes. |
| Playwright | 1.64.1 (2026-10-19) | [npm](https://www.npmjs.com/package/playwright) | Same version as our `playwright-core` pin. |

## New references

| Reference | Version | Link | Why it matters here |
| --- | --- | --- | --- |
| Windows-MCP (CursorTouch) | v0.8.8, 2026-10-10; `main` at `354e3dd7` | [GitHub](https://github.com/CursorTouch/Windows-MCP) | Windows desktop MCP server in Python. Its README lists `ControlStatus` and user takeover: a visible edge glow while the agent controls the desktop, and moving the physical mouse or pressing Ctrl+Alt+Shift+Backspace hands control back until 10 s of idle. Also `WaitFor`, region screenshots, `DisplayInventory`, `Clipboard`, `Process`, `PowerShell`, `FileSystem`. Its takeover is documented as best-effort, not a security boundary. |
| Microsoft UFO³ | v3.0.10, 2026-09-22; `main` at `eae3c0a8` | [GitHub](https://github.com/microsoft/UFO) | Windows agent (UFO², LTS) on UIA/Win32/COM plus a multi-device orchestrator (Galaxy). The v3.0.10 release note is only a changelog link. The "51% fewer LLM calls" claim for speculative batching is the project's own. |
| Gemini Computer Use tool | `gemini-3.8-flash` in the current docs | [Gemini API docs](https://ai.google.dev/gemini-api/docs/computer-use) | Verified in the docs: browser, mobile and desktop environments, an `intent` field on every action, and opt-in prompt-injection scanning of screenshots. Release dates come from a search summary and are not verified. |
| Cua Driver `run_script` / `run_steps` | 0.35.0+ | [CHANGELOG](https://github.com/trycua/cua/blob/cua-driver-rs-v0.36.0/libs/cua-driver/rust/CHANGELOG.md) | Driver-side orchestration that overlaps our Codemode and batches; see "Not adopted". |
| Benchmarks | OSWorld `main` at `6b3de7ea` (2026-10-19), last tag v0.1.16 (2024); WindowsAgentArena `main` at `6d39ed88` (2024-11-20) | [OSWorld](https://github.com/xlang-ai/OSWorld) · [WindowsAgentArena](https://github.com/microsoft/WindowsAgentArena) | OSWorld-Verified is maintained; WindowsAgentArena has had no commits since 2024. Leaderboard scores circulating in October 2026 (around 85–90% on OSWorld-Verified, around 70% on WAA) are vendor or tracker reports and are not verified. |

Also active but not reviewed in depth: Playwright MCP 0.0.83, browser-use 0.13.13 (Python), UI-TARS-desktop v0.3.1, Agent S v0.3.2.

## Gaps

Capabilities a reference has that this project lacks, with a suggested priority.

- **High — user takeover.** Physical mouse or keyboard input from the human should pause foreground agent input and say so (Windows-MCP `ControlStatus`). Today our foreground input can fight the human.
- **High — rebase the CUA fork onto 0.36.x.** We miss upstream fixes that we hit in M7: `launch_app` resolving to the real app window (our Notepad launch returned "multiple possible new windows"), and a stated reason when a Windows desktop cannot be captured (we get white screenshots from a disconnected RDP session). The 0.35.0 lean-output change needs adapter work before adoption.
- **Medium — native incremental UI reads.** `get_window_state` `since: <snapshot_id>` returns only changed rows. We walk the full tree and compute successor diffs in the adapter.
- **Medium — visual regions beyond text.** Cua's perception extension (`parse_visual_regions`, shipped by default in amaster) finds icon and text regions. We have Windows OCR for text only; perception needs its signed catalog installed.
- **Medium — action-time confirmation categories.** Codex sorts risky Windows actions (payments, sending, credentials) into hand-off and always-confirm. We only have Safe/YOLO and skill rules.
- **Medium — task-success benchmark.** We measure latency (LPT-806) but run no standard task suite. A small WindowsAgentArena-style subset inside a session-opened Windows Sandbox would give comparable success numbers.
- **Low — prompt-injection screening of observed content.** Gemini offers opt-in screenshot scanning; we rely on the skill rule that app content is data, not instructions.
- **Low — action intent in receipts.** Gemini returns an `intent` with each action; a short agent-supplied reason in our receipts would help review and recordings.

Already tracked in M7, so not repeated as gaps: screen recording (LPT-817), frame stream (LPT-810), audio (LPT-819), app scripting (LPT-821).

## Not adopted

- **Attaching to an existing or personal browser profile** (Cua 0.35.1 existing-profile attach, pi-browser-use existing-browser mode, Codex Chrome binding). AGENTS.md: "Never attach Playwright to a personal browser or profile." LPT-820 waits for the owner's decision.
- **CUA browser tools and a CDP fallback.** Playwright owns pages in session-opened browsers, and AGENTS.md forbids "a fallback between Playwright and CUA".
- **Driver-side `run_script` and `run_steps`.** They call driver tools directly and would skip the adapter's ownership, Safe-mode and freshness checks; AGENTS.md: "An adapter must not bypass ownership or Safe mode." Pi Codemode, `sequence` and `batch` cover the same orchestration through the adapter.
- **Desktop or normalized coordinates as input** (Anthropic screenshot space, Gemini 0–999, Windows-MCP screen coordinates). AGENTS.md requires coordinates local to the returned window image; display pixels never ground input.
- **Unrestricted shell or file tools on the computer surface** (Windows-MCP `PowerShell`/`FileSystem`, husain's `exec_py`). Pi already has its own shell tools; the computer surface stays UI-only, with the owned session folder for files.
- **Multi-device and other platforms** (UFO³ Galaxy, Android, Linux, macOS-only Cua features). AGENTS.md limits current work to Windows controlled from WSL, locally or over SSH.
- **Automatic driver updates and extension installs** (`check_for_update`, `install_extension`). AGENTS.md: no silent auto-update at startup; runtimes are pinned and qualified explicitly.
- **Taking over the whole desktop** (Codex on Windows takes the foreground for the task). We keep background delivery first and foreground only after an observed refusal.
