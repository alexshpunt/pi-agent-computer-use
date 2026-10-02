# Safe Windows access results

**Pass for LPT-365** on runtime and evidence revision [`eb65fa40de9618a559262fe8fe6ba0c12b87f9d4`](https://github.com/alexshpunt/pi-agent-computer-use/commit/eb65fa40de9618a559262fe8fe6ba0c12b87f9d4), checked on 2 October 2026. This qualifies session-owned Safe access with Windows Notepad, not an OS sandbox or every installed app.

## What changed

The user selects `/computer-mode safe` or `/computer-mode yolo`. New sessions default to YOLO. The selected mode appears in the footer and tool results; it is saved in the Pi session and restored on reload. There is no model tool or tool argument for changing policy.

Safe owns individual windows opened by the extension, not processes. It filters discovery and refuses old outside-session references before native UI reads or input. Closed/recycled handles cannot inherit ownership. Unknown or ambiguous launch results grant no ownership. Mode changes are checked again after awaited native work; foreign returned UI state is withheld. Already-dispatched input cannot be undone.

## Environment and checks

Pi ran in WSL and controlled the interactive Windows desktop through the existing Cua Driver **0.32.0** user-local install and inherited WSL interop. No target config, IDE change, app install, elevation, service, or saved test file was needed. Node was **24.20.0**; project dependencies included Pi **0.99.1**, MCP SDK **1.31.0**, and pi-coding-agent-test **0.1.3**.

The final automated run passed **29 unit tests**, **2 real-Pi MCP fixture tests**, and `tsc --noEmit`. Policy contracts cover old refs, shared PID, recycled HWNDs, ambiguous opening, ownership loss on runtime close, user-command restoration, invalid model policy arguments, and mode changes during identity, discovery, observation, and input.

The real-Pi fixture restores a trusted saved Safe choice and exercises actual registration, validation, tool execution, footer, MCP, and EOF without IDE. It does **not** pretend that this seeded choice is interactive user input or native Windows evidence. The native and actual user-command checks below provide those separate proofs.

## Actual user-command and native results

| Check | Observation |
| --- | --- |
| YOLO outside-session access | A separate preparation backend created one empty disposable Notepad, then closed. Parent Pi discovered it as unowned, wrote `SAFE canary 365`, and verified tree plus PNG. |
| Opening in Safe | Parent Pi opened a new blank single-tab Notepad in Safe and wrote `SAFE owned 365`. The first observation and fresh written state included scoped PNGs. |
| Mode changes without reload | The user selected Safe → YOLO → Safe → YOLO through the actual command. After the new window was opened in Safe, its reference survived every subsequent mode change. No source changes or reload occurred during that cycle. |
| Old canary read and write in Safe | Both returned explicit Safe policy refusal using the previously valid canary reference and observation. No UI state was returned. |
| Shared process | Canary HWND **19533740** and owned HWND **5641318** shared PID **55776**. Safe discovery exposed only the owned window. Owning it did not grant the canary. |
| Owned access after switching | In Safe, a grounded value change produced `SAFE owned 365 after switch`; fresh UI value and PNG confirmed it. |
| Return to YOLO | The same canary reference worked again. Its exact text remained `SAFE canary 365`; the denied write had not changed it. |

[Compact parent results and actual user choices](evidence/safe/parent-run.json) retain the relevant ordering and references. [Owned state after switching](evidence/safe/owned-after-switch.png) and [restored unchanged canary](evidence/safe/canary-restored.png) are original Pi tool PNGs, visually checked by the agent.

A separate [native adapter record](evidence/safe/native-denial.json) wraps the real McpDriver, not a fake backend. During its Safe discovery/read/write denial segment, it recorded **zero Driver calls and zero lifetime-peer calls**. Returning its trusted test controller to YOLO confirmed the unchanged canary, also checked in [the native PNG](evidence/safe/native-canary-after-denial.png). That controller is native contract evidence, not a user command.

## Real human viewport

`inspect_tui` captured Herdr pane **w3G3:p1**, **274×108 cells**, revision **473**, at the live bottom. [The original viewport PNG](evidence/safe/safe-viewport.png) shows the user's Safe notification, both explicit canary denials, owned results, and `Computer: SAFE` footer. Text is readable and aligned. Stock collapsed results hide most UI JSON and inline images; human inline PNGs were not required. The agent still received and checked the scoped app screenshots.

## Interrupted preliminary setup

An earlier preparatory runtime lost both of its references before the first mode check. The owned Pi session file was rewritten to a `.surgery-…` file at **18:59:29 UTC**, after those windows were prepared and before the first Safe selection at **19:08:22 UTC**. That attempt is retained in the compact trace but is **not** counted as a passing mode transition. This is evidence of session-file replacement, not an independently traced shutdown cause or a claimed code fix. The later complete cycle on unchanged runtime code preserved references throughout actual user commands.

The earlier empty HWND **77532910** was already absent before final cleanup. On YOLO restoration, the canary had a save prompt; the agent used its freshly observed **Cancel** control and verified the unchanged editor. It never selected Save. No claim is made about who closed the earlier empty window.

## Cleanup and limits

Both remaining written test editors were cleared, then observed as blank, unmodified single tabs. Their observed **Close Tab** controls closed them through background UIA Invoke without saving. Discovery returned no Notepad windows. `computer_close` released the owned Driver and identity peer. A read-only Windows handle/process check confirmed all **three** recorded test HWNDs absent, test PID gone, owned Driver count **0**, and lifetime-peer count **0**: [cleanup record](evidence/safe/cleanup.json).

Native `set_value` reported delivery `unknown` and effect `unverifiable`. Fresh value plus PNG proved the change; this does not prove focus or pointer non-interference. No foreground fallback was needed in this Safe cycle.

Safe is a UI policy only. It does not isolate shell tools, files, clipboard, network, shared app state, or capabilities inside an allowed application. Previously received YOLO contents remain in conversation history. Native window metadata is enumerated internally for launch correlation and owned-window discovery. Lifetime validation and Driver dispatch are separate, non-atomic operations; unrelated concurrent same-app launches are not causally isolated.

Reload, session replacement, and `computer_close` discard ownership and references. Safe cannot adopt surviving windows. Sandbox research stays in LPT-364; the final IDE provider API and extraction remain separate.
