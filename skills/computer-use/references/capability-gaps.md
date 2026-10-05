# Codex-to-Pi capability gaps

This list records differences from the installed Codex unified Computer Use instructions. These are candidates for the next tasks, not permission to implement them or claims that CUA lacks every underlying primitive. Check the newest upstream docs/source and qualify the public Windows route before adding an adapter. Do not patch the Driver or introduce another capture/input backend.

## Next-task candidates

| Capability from Codex | Current Pi boundary | Candidate / dependency |
| --- | --- | --- |
| Shared app/tab objects and one structural inventory | Separate `computer_*` window refs and focused `browser_*` hints | LPT-386 and LPT-388 |
| Stable structural target handles across observations | Browser hints are snapshot-scoped; desktop observation is consumed by one dispatch | LPT-387; never silently rebind stale hints |
| Create, activate and close individual browser tabs | One active owned tab required; list/focus does not activate; close ends the whole owned session | Browser lifecycle adapter, only if public CUA can support owned-tab identity |
| Back, forward and reload | Only explicit URL navigation is exposed | Browser navigation adapter; never reset puzzle progress as a refresh shortcut |
| Browser arbitrary keys/chords and typing into a focused target without replacing its whole value | Browser exposes `fill`; desktop exposes literal text and a small key enum | Extend native input contracts before documenting equivalent `typeText`/`pressKey` behavior |
| Right/middle/double clicks | Browser/desktop public Pi click schemas expose the normal click only | Qualify CUA gestures and add guarded tool parameters |
| Complete drag gestures | No public Pi browser/desktop drag action | A complete drag may be an adapter task; it is not held state across calls |
| Key down/up, hold intervals | No qualified public Windows raw held-key contract | LPT-383 blocked; a complete hotkey is not key-down state |
| Stateful mouse and relative movement | No held-button state across public calls | LPT-384 blocked |
| Continuous trajectories/Bézier | No continuous held-button trajectory contract | LPT-385 blocked behind LPT-384; segmented drags are not continuous strokes |
| Scroll by coordinates/page count and native app scrolling | Browser currently requires a hint and bounded `delta_y`; no desktop scroll action | Qualify CUA scroll plus observation geometry before extending |
| Formatted paste (`md`/`html`) and clipboard restoration | No paste/clipboard tool; browser fill and desktop type_text are literal text only | Explicit paste contract, permissions and clipboard ownership; not an alias for fill |
| Select a text span with prefix/suffix or cursor placement | Desktop only select_all; no arbitrary span selection | Structural text selection task, based on actual accessibility support |
| Secondary accessibility actions such as Expand/Increment/Cancel | Current Pi schema has click/set_value and limited keys, not arbitrary exposed actions | LPT-388; only dispatch actions present in the fresh tree |
| Dedicated focused_element, selected_text, selected_elements and document_text fields | Current output is the returned CUA tree/text plus source metadata | LPT-386; use verified fields rather than infer a rich selection API |
| AX-only observations, diffs and full-state controls | Browser overview includes fresh semantics+PNG, or PNG-only; desktop query filters the tree but does not skip capture | Observation policy adapter; do not claim current diffs or capture-free AX |
| Linux/macOS app automation and their platform-specific semantics | This project's live-qualified app/browser adapter is Windows/WSL | Platform matrix under LPT-275; no parity claim without live checks |
| Deliverable/handoff tab lifecycle markers | No matching public Pi operation | Optional lifecycle convention, not evidence of OS/browser isolation |
| Automatic observation emission and internal waiting | Codemode needs explicit `text`/`image`; native pixels can lag semantics | Keep explicit output and bounded re-observation; no readiness promise |

## Already available, not missing

- Owned browser launch, snapshot hints, click, fill, hover, bounded scroll and URL navigation.
- Browser overview and fresh native zoom; browser points can be grounded in the returned overview or JPEG.
- Windows app discovery/open/window discovery, tree+PNG observation, grounded click/text/set_value/select_all and limited keys.
- Primary-display observation and fresh display detail in YOLO, read-only and not an input source.
- Window detail is read-only. A fresh window overview is needed before input.
- Existing Pi Codemode sequencing, explicit image forwarding, visible native agent cursor and human whole-window observation frames.
- Normal Pi image retention and compaction. No separate cache/prefill/prewarm task or image eviction layer.

## Preservation versus executable instructions

`codex-unified-original.md` is an exact local source copy for review. It is not an executable Pi skill and does not grant access to Codex services, personal tabs or another backend. The adapted `SKILL.md` keeps the original topic order and workflow, but uses actual Pi parameters and clearly labels unavailable operations. No replacement runtime or compatibility object is installed.
