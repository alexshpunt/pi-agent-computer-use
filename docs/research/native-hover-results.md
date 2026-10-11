# Native move and hover: Windows/WSL check

## Result

The isolated Windows candidate passed the two-window live scenario on 2026-10-11. This is bounded application evidence, not the complete CUA desktop certification or approval to replace the production runtime.

- Source: `ce28c95175efc97a040cebebd80fec63526aec64`.
- Driver: `0.34.0`, unsigned research artifact.
- Driver SHA-256: `ee0d2a6d8593512eaa4e5cd1466f3902cfdf85111628f2f54859c60adac67197`.
- [Exact Windows build](https://github.com/alexshpunt/cua/actions/runs/38117294819): contract 68, core 841, Windows library 311 with one existing ignored test; pointer contract 3, pointer execution 6, protocol suites 2 and 4. Build and packaging passed. All three downloaded and copied EXE hashes matched the artifact manifest.
- Pi loaded this worktree through its normal loader after an explicit reload. The IDE checkout was clean at fetched `origin/develop`, package `0.8.0`, commit `394f3784fb3e34a46a1727f3c9cdaf1c5af408ed`.

The profile `windows-native-pointer` selects these exact bytes. It keeps the persistent-WGC base's capture, Bilinear and input capabilities. Older profiles and the bundled default do not advertise native pointer movement. Selection is trusted config, never an agent tool argument.

## Live steps

Two new Chrome processes used separate disposable profiles and local fixture pages. No personal browser data, documents, accounts or external forms were used. The helper launched the fixtures and collected witnesses; all measured movement used production `computer_*` tools through Pi Codemode.

1. Discover the exact target and sentinel, then observe their native UI and window PNGs.
2. Request background `move` at window-image `(95,148)`. Native refusal reported `background_unavailable`, no activation, movement or delivery. The independent pointer/focus sample and both pages' input journals stayed unchanged.
3. Observe again and request foreground `move` at the same current image point. One movement was delivered with no dwell. A new native screenshot and UI tree showed **Hover-only menu visible**.
4. Find the current **Hover tooltip 0** hint through the collected UI resource. Background `hover` with `dwell_ms:800` refused without movement.
5. Observe again and request foreground `hover` using its new hint. The native receipt reported 800 ms completed dwell. A new screenshot showed **Native hover tooltip visible**, whose fixture delay is 500 ms.
6. Observe the sentinel. It showed neither menu nor tooltip. Its independent journal contained zero events; the target journal contained ten trusted pointer events, all with `buttons:0` and no key. Click, button, key, text and wheel counters were zero on both pages, with no dropped events.
7. Read-only Win32 samples identified the target as foreground and the window under the pointer. The real pointer and target remained there through subsequent read-only observations. These PowerShell coordinates have no qualified DPI mapping and never ground input.
8. Save witnesses before cleanup. Close only the two task-owned windows and remove their profiles. Both cleanup results passed; production discovery then returned no matching windows. Release the runtime and discard the stored references.

[Menu screenshot](native-hover-evidence/menu.png) · [Tooltip screenshot](native-hover-evidence/tooltip.png) · [Unchanged sentinel](native-hover-evidence/sentinel.png).

[Independent witnesses and cleanup](native-hover-evidence/witnesses.json), [move receipt](native-hover-evidence/move-result.txt) and [hover receipt](native-hover-evidence/hover-result.txt) preserve the measured results. Receipt delivery alone was not used as the application-effect oracle.

## Regression and human checks

The real-Pi tests exercise production tool registration, Codemode, admission and MCP with synthetic native identities and outcomes. They protect one-use observations, Safe ownership, wrong/closed/reused windows, malformed completions and uncertain prefixes. They do not replace native application checks. The test fixture uses the production animation wrapper; losing its pointer capability produced two failures before the forwarding fix.

The final extension run passed all 45 unit files / 418 tests, typecheck and both real-Pi scenarios. The scenario artifacts record IDE `0.8.0` at the same verified `394f3784fb3e34a46a1727f3c9cdaf1c5af408ed` source.

Final review found a test gap: malformed receipt cases used default background, so they could pass without exercising completion validation. They now explicitly request foreground and include a valid delivered case. Temporarily accepting a 99 ms completion for a 100 ms request made the strengthened test fail; the original check was restored.

`inspect_tui` captured the real Herdr viewport after the live hover. Its compact activity rows showed successful move/hover and fresh observations, and failed background calls distinctly. The viewport did not display the forwarded app PNGs inline; native screenshot evidence above is separate from this renderer check.

## Limits and remaining gate

The owner explicitly kept Windows/WSL scope and the native PR in draft. All M4–M6 task descriptions now state this scope. Other platforms are not approved or verified, and no test environment is available for them. Their qualification is not part of current feature acceptance.

- Native receipt `effect` remains `unverifiable`; a tooltip is not promised for other apps.
- Foreground may disturb the human pointer and focus. There is no restoration or automatic escalation.
- Win32 hit testing and `SendInput` are not atomic against outside desktop changes. This is not OS input isolation.
- Pixel actions without native target geometry honestly report the human target mark as unavailable. Current token geometry can produce a mark; neither is measured pointer evidence.
- Cancellation and uncertain prefixes are covered by the native execution engine and Pi regressions. The live two-window run did not inject in-flight cancellation.
- macOS/Linux do not register this Windows tool. Their native window control remains outside the extension's qualified scope.
- The CUA PR remains draft until its final exact-source desktop certification gate is satisfied. This smoke is not permission to skip that gate, publish a release, merge CUA or change the normal runtime.

## Reproduce the approved fixture

Select the byte-checked candidate only in a task worktree's ignored `.pi/computer-use.json`. Use the development skill's single-loader startup check and reload. Fetch and verify the current IDE checkout before every Pi run, and record its package version and commit.

Run `node --experimental-transform-types scripts/native-hover-fixture.mjs --live-approved`. Wait for both ready witnesses. Its `mark <label>` command saves read-only state; `finish` saves the final measured state, closes only its owned fixtures and removes their profiles. Use only the production computer tools for measured actions. Unknown input or launch results must not be replayed.
