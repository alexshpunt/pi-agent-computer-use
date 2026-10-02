# Standalone Windows PoC result

**Pass for the approved Notepad scenario.** Pi in WSL edited a native Windows document through Cua Driver, without Pi Agent IDE. This proves one useful path, not general computer-use reliability.

Task: [LPT-356](https://linear.app/alexshpunt/issue/LPT-356/prove-standalone-windows-computer-use-from-pi-in-wsl). Tested extension revision: [`70f94a74c634e1e9a94c663b7bad5a7a7064817a`](https://github.com/alexshpunt/pi-agent-computer-use/commit/70f94a74c634e1e9a94c663b7bad5a7a7064817a). Verification date: 2026-10-02. Later report-only changes do not change the tested extension.

## Environment

| Part | Observed value |
| --- | --- |
| Windows | 10.0.26200.9457, x86_64, interactive Session 1 |
| Notepad | Microsoft.WindowsNotepad 11.2607.14.0 |
| WSL kernel | 6.18.33.2-microsoft-standard-WSL2 |
| Node / running Pi | 24.20.0 / 1.0.0 |
| Test package | pi-coding-agent-test 0.1.3 |
| Model | openai-codex/gpt-6.1-sol |
| Native Driver | cua-driver 0.32.0, release source 66ca6c0833a7e04dd611c473100ba36bbf1f11be |
| Connection | WSL Windows executable interop; owned stdio MCP process, `mcp --direct --embedded` |
| Authorized target | PID 39124, HWND 61017014, one new empty Notepad document |

The user-local archive hash and all three EXE signatures were verified. See the [setup guide](standalone-poc.md) for the hash, install boundary, and reproduction commands. No admin, autostart, service, firewall, SSH, or global Pi setup was changed. The working Pi Agent IDE checkout stayed unchanged.

## Live result

After reloading the project-local extension, the parent Pi observed the empty editor, inserted `Pi computer use PoC 123`, changed it to `Pi computer use PoC 456`, and read fresh state after each action. Tree values and scoped screenshots agreed.

`node scripts/live-notepad.mjs` then repeated the scenario in an isolated real-model Pi with only `computer_windows`, `computer_observe`, `computer_act`, and `computer_close`. No IDE extension was loaded. It finished in 46 seconds, with two write actions and four observations. This duration is a run record, not a performance benchmark.

| Write | Requested delivery | Native result | Fresh verification |
| --- | --- | --- | --- |
| `type_text`, text ending in `123` | background | UIA ValuePattern, delivery background, effect confirmed, value readback | Document value and PNG show exact text |
| `set_value`, text ending in `456` | background | UIA ValuePattern, delivery unknown, effect unverifiable | A fresh editor query and PNG show exact final text |

No foreground input was requested for text editing. We did not independently measure focus or pointer non-interference. In particular, the `set_value` acknowledgement alone was not treated as proof.

One post-write observation had no matching values. The model obtained another observation of the editor instead of declaring success from the window title alone.

Tracked evidence:

- [Initial empty window](evidence/notepad-initial.png)
- [Final text](evidence/notepad-final.png)
- [Compact observations, action arguments, and native results](evidence/notepad-run.json)

The images were read visually as well as checked through structured state. Full session bundles, credentials, and unrelated application contents are not in the evidence export.

## Real TUI

`inspect_tui` captured the actual human-visible Herdr pane `w3EE:p1` after live tool calls: revision 233 at 158×57 cells, and revisions 205 and 222 at 274×108 cells. The standard text panels showed the exact target, observation IDs, action status, requested delivery, and native delivery fields. The layout was readable; detailed JSON was collapsed with an expansion hint.

No inline screenshot appeared in the checked viewport. Pi only adds inline image components when the terminal advertises image support. The agent still received the PNGs. The user explicitly removed mandatory human-visible images in the TUI from PoC acceptance; screenshots remain required for agent observation and verification. No custom renderer or terminal configuration change was made.

## Cleanup

Only the owned test editor was cleared. A fresh observation showed an empty, unmodified tab before closing the window, so no save operation was needed.

A capture-bound tab click was first refused because its capture had expired. A new background click and a later background window-close click returned delivery acknowledgements but did not close the window. Fresh observations established these no-ops. An explicitly authorized foreground close then returned an unknown outcome because the target was no longer foreground after dispatch. It was not retried blindly: discovery and a Windows process query confirmed that the target window and PID were gone.

`computer_close` released the parent runtime. A separate successful Windows process query found zero Driver processes from the owned PiComputerUsePoC install. The installed binary remains available for future authorized experiments. Temporary bundles and the stale target configuration were removed after durable capture.

## Contract checks

`npm test && npm run test:integration && npm run typecheck` passed on the tested code:

- 7 unit contracts: wrong target, observation/image preservation, stale and foreign references, exclusive native target addressing, honest partial/error results, interrupted dispatch, and pre-dispatch cancellation.
- 1 isolated real-Pi contract with a deterministic MCP fixture: extension loading, fresh observation, stale-write refusal before native dispatch, and owned child EOF cleanup.
- TypeScript typecheck.

The fixture is not native Windows evidence. The separate real-model run provides that evidence.

## Findings and limits

The first native run exposed a wrapper bug: preferred `target` and legacy `pid/window_id` were sent together. Cua rejects that combination. The fix sends only the advertised addressing shape, and a regression test checks it. That initial error was not evidence that background typing is unsupported.

A later attempt stalled on a model connection timeout before Windows actions. Another attempt refused a missing WSL interop socket after WSL restarted. Using the new inherited endpoint restored the same authorized target. These failed attempts are not exported as the passing run.

Browser/CDP, other applications, other platforms, arbitrary input, background clicks, and production safety are not qualified. Synthetic background clicks were not reliable in this cleanup. The exact-target guard is not an OS sandbox. The final IDE provider API, migration boundary, and coexistence checks remain open.
