# Surface capability matrix (LPT-628)

What each execution surface on one Windows machine can do, measured live, and how the surfaces stay apart. The check is `test/live/surface-matrix.live.ts`; it runs against a Windows 11 25H2 machine reached over SSH from WSL with fork runtime e6d26cb6. Linux desktops are out of scope (LPT-622/623 were canceled).

Each native surface gets its own disposable WinForms target (`nativeForm` in `test/live/remote.ts`) and its own text, so an action that leaked into a neighbour would show up there. The host target only takes background input: foreground input on the host would take the human's foreground.

## Matrix

Observe and input times come from two passing runs, open times from three more: the median of three Reads for observation, one action for input, and launch until the window is discoverable for open.

| Surface | Source domain | Observe | Input | Delivery | Focus | Open |
| -- | -- | -- | -- | -- | -- | -- |
| Display (the test machine has one) | `windows-remote` | 680–750 ms, default overview | refused: display observations are readonly | none | none | — |
| Host window | `windows-remote` | 86–96 ms | type 24–28 ms | background | the human's foreground is untouched; foreground input exists but is not exercised here | 2.1–6.8 s |
| Windows Sandbox | `windows-sandbox` | 95–150 ms | type 324–395 ms | foreground inside the guest | the guest's foreground only | 4.6 s after the sandbox is up |
| Isolated session | `windows-session` | 98–106 ms | type 89 ms | foreground inside the session | the session's own desktop | 1.0–1.4 s after the session is up |
| Owned browser | page via Playwright | DOM snapshot 12–20 ms | press 18–23 ms | Playwright | not needed | — |

Strict UIA actions (`invoke`, `select`, `set_value`) are qualified separately (see [semantic actions](../semantic-actions.md)): on the current desktop they no longer take the foreground; on another desktop many apps expose no content.

## Separation

Every run checks:

- Each surface's Search lists only its own source domain.
- After every surface has acted, each target holds exactly its own text, and the browser journal holds exactly the one key pressed there.
- A `dom` Read on a sandbox window is refused; DOM reads belong to owned browsers.
- A native Write into a DOM observation is refused with nothing sent.
- Input into a display observation is refused: "Display observations are readonly".
- A second agent (its own provider) cannot resolve the first agent's session window reference, and a closed sandbox's window reference resolves nowhere. No open surface claims such a reference; it falls to the local host session, which refuses unknown windows. The live harness forbids local use, so its guard error is what the check sees.
- The isolated session keeps working after the sandbox next to it closes.

## Limits

- One of five runs failed to open the form in the isolated session: the launch reported "Window identity check timed out" and no window was found within 20 s. Later runs opened it in about a second; the cause is not established.
- The test machine has a single monitor, so the non-primary display row is not measured.
- Sandbox typing is several times slower than session typing, although both reach their driver through a relay; the cause was not measured.
