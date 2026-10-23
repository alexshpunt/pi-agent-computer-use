# Native CUA input gaps

## What was checked

On 2026-10-05, a metadata-only MCP probe reached the installed, unmodified Windows CUA 0.33.2 from WSL. It listed all 59 tools, including the keyboard, pointer and legacy page schemas. It sent no input and requested no pixels. The process closed through EOF. Read-only cleanup found zero Driver processes, Qt helpers and owned browser profiles.

Run `node --experimental-transform-types scripts/probe-cua-input-capabilities.mjs` to inspect the qualified pin again. This script does not change the production API, driver pin or machine setup.

The source review used release commit [c82d32e3e1adbc6578a148962002ddf6e3e8a15a](https://github.com/trycua/cua/tree/c82d32e3e1adbc6578a148962002ddf6e3e8a15a/libs/cua-driver/rust). Current [0.33.3 release notes](https://github.com/trycua/cua/releases/tag/cua-driver-rs-v0.33.3) report browser-consent settlement and a macOS Finder set_value fix, not new held-input primitives. That release was not installed or runtime-qualified; production stays on 0.33.2.

## Available is not the same as exposed or verified

| Route | Native public contract | Gap for the accepted task |
| --- | --- | --- |
| Windows keyboard | press_key, hotkey, type_text; text delay_ms 0..200 | No separate key-down/up, requested hold duration or arbitrary event sequence |
| Owned browser keyboard | browser_type insert_text or per-character keystrokes | Character typing is not arbitrary key/code/modifier events with caller-controlled down/up timing |
| Windows pointer | click/right/double, scroll and one complete drag; drag duration 0..10000ms, steps 1..200 | No public held-button state across multiple calls or arbitrary path points |
| Owned browser pointer | hover/right/double/scroll and one complete drag between refs or CSS endpoints | No independent button-down/up or caller-sampled held path |
| Agent cursor | move_cursor window scope and cursor motion/theme settings | Overlay movement is human feedback, not application mouse movement or drawing |

These entries come from the live schemas, not a claim that all these routes have passed our fixtures. Our production adapter currently exposes only its documented subset. The legacy page route offers text/keystrokes and JavaScript operations; it does not add a held-input contract. Direct DOM/canvas mutation would not satisfy physical input acceptance and is not an approved fallback.

## Why composition cannot fill the gap

Windows [post_key](https://github.com/trycua/cua/blob/c82d32e3e1adbc6578a148962002ddf6e3e8a15a/libs/cua-driver/rust/crates/platform-windows/src/input/keyboard.rs#L332-L402) presses modifiers, presses a key, sleeps internally, releases the key, then releases modifiers. A delay between complete calls cannot make a single key stay down across calls.

The [browser_type schema](https://github.com/trycua/cua/blob/c82d32e3e1adbc6578a148962002ddf6e3e8a15a/libs/cua-driver/rust/crates/cua-driver-core/src/browser/tools.rs#L1528-L1558) exposes text plus a typing mode, not raw key events. Internal CDP code is not a public adapter entry point.

The source does have [mouse_button_down/up and mouse_drag in platform-linux](https://github.com/trycua/cua/blob/c82d32e3e1adbc6578a148962002ddf6e3e8a15a/libs/cua-driver/rust/crates/platform-linux/src/tools/impl_.rs#L11136-L11170). [Current pointer documentation](https://cua.ai/docs/cua-driver/reference/mcp-tools/pointer) marks these methods Linux-only. Their presence in shared capability names does not make them callable on the Windows host. Running a Linux driver from WSL would address another desktop, not repair this Windows route.

Even the internal [interactive gesture folder tests](https://github.com/trycua/cua/blob/c82d32e3e1adbc6578a148962002ddf6e3e8a15a/libs/cua-driver/rust/crates/cua-driver-core/src/interactive_input/gestures.rs#L333-L362) collapse key-down into a complete key press and drop releases/bare modifiers. It is not evidence of a public held-key API.

## Task consequences

The original LPT-383–385 scope required held keys/buttons and continuous paths that this public Windows route cannot provide. The user explicitly replaced it with complete gestures:

- LPT-383: complete keys/chords and bounded keyboard sequences with requested waits and measured dispatch/completion times.
- LPT-384: complete clicks, right/double clicks, scroll and straight drags through the existing computer_act.
- LPT-385: computed shapes made of independent complete straight strokes, with release between segments.

The adapter implements this narrower contract. Native application events/final pixels and the reloaded production parent verified complete keyboard batches, right/double clicks, token scroll and independent straight strokes. Pixel scroll is deliberately refused: the pinned foreground route failed resized-image coordinate mapping in the native fixture. No driver fork, independent CDP dispatcher, SendInput helper, held-input state or global release-all was added. Future held-input support still requires an upstream public capability and separate acceptance. Research completion is not feature completion.
