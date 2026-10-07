# Windows shell desktop membership results

LPT-624 passed the read-only membership checks on the current Windows host through production Pi tools after reload. Only two new isolated Chrome fixtures were used. The owner placed them on existing Task View desktops, switched desktops and moved one fixture. No personal window or desktop setup was changed by the agent.

## Exact native build

Source `506239da08cfdafa63dac1857f5471752fb70f5e` passed [Windows run 37644393673](https://github.com/alexshpunt/cua/actions/runs/37644393673). The driver SHA256 is `0e25c8b83fd48b54be479eb128452a6f6b099b5ff6ce2d20bac024eda07ead16`. All three executable hashes matched the downloaded artifact. The binaries are unsigned; UIAccess signing is not established.

Windows checks passed 65 contract, 830 core and 289 platform tests, with 1 ignored, plus 6 protocol/schema tests. The earlier Linux hermetic checks passed 65/843/102; those alone did not compile the Windows producer. The exact Windows MCP handshake reported 0.34.0, 62 tools and the EOF-aware envelope transport. Both public window output schemas include membership; existing paths, keys and capture-bound drag remain present.

[Fork RFC8](https://github.com/alexshpunt/cua/issues/8) and [draft PR9](https://github.com/alexshpunt/cua/pull/9) record the focused owner-fork experiment. This is not upstream approval, a merged stack, or a complete desktop E2E matrix.

## Live result

The production route was `computer_windows` with the exact fixture-title query, then authorized `computer_observe` calls. GUIDs below use aliases A/B; no full desktop inventory was collected.

| Check | Observed result |
| --- | --- |
| Owner placement | Fixture1 on existing desktop2 returned known GUID A; fixture2 on desktop3 returned distinct known GUID B. |
| Owner's normal desktop active | Both current-desktop flags were false, not unknown. |
| Visit desktop2 | Fixture1 current=true; fixture2=false. GUIDs and window refs stayed unchanged. |
| Visit desktop3 | Fixture1=false; fixture2=true. GUIDs and refs stayed unchanged. |
| Return to normal desktop | Both flags false again. |
| Available overviews | Each fixture's overview on its active desktop returned the matching GUID/current flag and synthetic marker pixels. |
| Move fixture1 to desktop3 | Its next native/production sample changed A to B while keeping its original window_ref. Fixture2 remained B with its original ref. |

The successful bounded visit pass took 25.358 seconds and 121 discovery calls. It stopped after both fixtures had been observed current and the owner returned. One earlier sampling attempt reached its call limit before the owner switched; it was not counted as a passing visit.

Queries were read-only. The agent did not activate a window, switch a desktop, move a window or send input during the measured phase. The owner performed those setup changes. Native samples and captures have separate timestamps; they are not claimed atomic.

The runner's independent final native sample matched the moved production result. It then removed both owned windows/profiles. Cleanup receipts report sourceGone/profileRemoved=true twice; production discovery returned zero matching windows. `computer_close` released runtime resources. The candidate also returned the two previously qualified monitor identities/bounds and scale 1.5, with DPI still unknown, without forwarding desktop pixels.

## Contract and human checks

Three source cases and two session regressions were red before their implementation. Tests preserve independent method failure, false current flags, missing/invalid metadata, zero GUID rejection, Safe revocation and recreated-handle refusal. Two new runtime-selection/qualification checks were red before adding the exact pin. Final checks passed 294 unit tests, 5 related real-Pi tests, typecheck, runner syntax and diff checks.

Real-Pi tests use a deterministic MCP peer: they prove loader/tool/Codemode behavior, not Windows COM. Their YOLO case exposes fresh membership without input or automatic image forwarding; Safe withholds outside-session metadata before native reads. An initial resource-pressure run failed before Pi became ready; a later run started normally. Test-script string parsing and a whitespace-sensitive assertion were corrected without weakening production checks.

Actual `inspect_tui` captures used Herdr pane `w3MD:pA`, 304x108 cells, live bottom, revisions 175 and 184. The final four-line production summary showed both complete GUID/current rows and the unchanged-window-ref result, readable without clipping or stray escapes. Earlier artifact dumps were verbose/collapsed; they were not treated as the final human-facing summary. No renderer or image-pipeline change was made, so no new private-viewer behavior is claimed.

Sanitized durable measurements are in [qualification.json](evidence/shell-desktop/qualification.json). Raw fixture GUIDs/targets and temporary logs stayed private.

## Limits and runtime

This proves membership for windows queried in the current Windows user session, not empty-desktop enumeration, desktop names/order, other sessions, sandbox isolation, hidden-window capture/input, focus guarantees or multi-agent arbitration. Membership is not lifetime or input authority. Failed/absent fields are never replaced with a guessed current desktop.

The owner chose to retain this exact candidate in a new permanent `cua-driver-0.34.0-shell-desktops-506239da` folder. All three executable hashes, licenses and build evidence were copied and checked again. The ignored local config now explicitly selects that folder and `windows-shell-desktops`; older installs remain untouched. Fresh installations still use the existing default. After the final reload, production metadata reads from the permanent runtime returned both correct monitor identities, bounds and scale, with DPI unknown. No desktop pixels were forwarded; `computer_close` then released the runtime.
