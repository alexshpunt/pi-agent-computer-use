---
name: reactive-visual-classifier
description: Build and run bounded visual reaction loops with computer_classify and Pi Codemode. Use for changing UI, games, waiting for visual conditions, and repeated screenshot classification. Keep intermediate images and results inside the program, skip completed targets, and stop safely on timeout, no progress, cancellation, or uncertain input.
---

# Reactive visual classifier

Use a small program to react to changing pixels without sending each frame to the reasoning agent. A skill is guidance, not a runtime sandbox or an enforced output filter.

Read [the classifier contract](../../../docs/visual-classifier.md) and [the computer-use skill](../computer-use/SKILL.md). Follow the native window observation and input rules. Classification alone grants no input authority.

## Plan the exits before the loop

Define these before sending input:

- The authorized window, visual region, condition and intended action.
- How to recognize success, failure, a changed level or a different screen.
- A finite total task budget and attempt limit. Reaching a chunk limit does not reset the total budget.
- A wall-clock deadline, frame limit, classification-call limit and action limit for each chunk.
- A no-progress deadline. Progress means a verified application change, not another frame, score or delivered click.
- A limit on unknown classifications and unconfirmed actions.
- The small final summary that may leave the program.

Every path needs an exit, including the all-false and all-unknown paths. Do not use an unbounded `while (true)`, recursive retry, or an unlimited sequence of bounded chunks.

Choose budgets for the task. For a first warm interactive chunk, a useful starting limit is 15 seconds, 12 frames, 64 classification calls and 8 actions, whichever comes first. Use `timeout_ms` as an additional hard backstop, with enough room for a slow call. Check the soft deadline and remaining budgets both before and after each awaited call; stop before another dispatch if they are exhausted. A hard timeout may interrupt work and is not a successful clean exit.

Warm the model in a separate read-only bounded call if cold startup would consume the reaction budget. Do not start a game action while waiting for model loading. Use English visual descriptions. Choose the threshold for the actual wording and crop, not a different image scale. Do not present cosine scores as probabilities.

## Keep the data inside the program

`await tools.computer_observe(...)` returns data to JavaScript. It does not by itself publish that data to the reasoning agent. `computer_classify` can consume the supplied image without the agent seeing it.

During the loop:

- Do not call `text`, `image`, `console.*`, or return intermediate observations, crops, classifier results, receipts or process output.
- Do not stringify whole tool results or enumerate their keys for debugging.
- Do not emit base64 as text. Do not place it in shell stdout or stderr: background completion can publish those streams outside Codemode.
- Do not save image payloads with text-editor tools inside Codemode. Their automatic edit receipts can publish the file contents even when you never call `text`. Use a bounded pixel-processing helper whose output contains only paths and counts.
- Keep one frame and a bounded set of candidates at a time. Do not accumulate frame history or append per-call logs to an unbounded array.
- Bound every local collection, crop count, pending call queue and retained state. Inspect the actual result type before parsing it.
- Keep only compact IDs, geometry, counters and task state in `store`. Never store images or whole results there.
- Avoid shell work in the hot loop. If existing local pixel processing is needed, use only supplied native pixels. Keep payloads in ignored private files, and let the process return only a bounded manifest or status. It must not become another capture or input backend.

An initial planning overview and a final diagnostic image may be useful. Emit them outside the reaction loop, with a fixed small count. Do not automatically show every frame on which no action happened.

Set a small `max_output_tokens` on every Codemode chunk. This limits text output, not memory, all image costs, or asynchronous messages. No-output intermediate calls are the first defense.

## Keep the reaction path short

Prefer one current overview and `computer_classify({image:view.image, region, condition, threshold})` for an eligible target. The integer region belongs to that supplied image, not a detail image or native screen coordinates. Crop happens in the warm worker's memory; do not take a second screenshot or start a shell just to crop it.

When checking several targets in one frame, pass `regions` once and use its ordered `results`. Do not confuse concurrent single-crop calls with a model batch: the worker serializes separate requests. Bound both tool calls and total crops evaluated. Skip empty batches.

For repeated snapshots of a known field, a one-frame `computer_sequence` with `capture.region` avoids an accessibility walk and crops only supplied native pixels. Inspect its actual frame count and stop reason, then select that frame privately. The crop's coordinates start at zero; do not mix them with the full-window coordinates. Sequence frames are read-only, so get a fresh window overview before input.

Do not insert sleep calls into a reaction loop unless pacing was explicitly requested. Observe and process sequentially as quickly as the bounded program can; keep native captures, classification and input timings separate.

For authorized reactive input, add `animation:"reactive"` to `computer_act` when a short cursor glide helps. The adapter restores the ordinary glide after each native call. This changes animation only, not native click pauses; count profile switching in the action timing. See [local configuration and failure rules](../../../docs/reactive-animation.md).

Classification neither consumes nor renews input authority. If no intervening read/action consumed the overview and its observed target is still valid, use that observation for the action. Otherwise observe again. Set a maximum frame age before dispatch; if analysis takes too long, discard that decision rather than clicking an expired detection.

Measure capture, classification and action separately, plus elapsed time from the native capture receipt to dispatch. The receipt timestamp is not a compositor timestamp, so it cannot prove the pixels' true age. Verification snapshots affect the next reaction's latency; bound them too. Warm-start time is not steady-state latency.

## Track completed targets separately

Detection and application state are different facts. An animal can remain visible after it has been clicked.

Before cropping or classifying, exclude targets that the application has confirmed as completed, selected, disabled or otherwise ineligible for the task. Use reported state when available. If it is absent, establish a visible state signal from the actual UI; do not invent native selection metadata.

Keep a bounded map of task targets and their state: eligible, pending, confirmed, or unknown. Use stable task geometry only while the observed layout remains the same. Native hints and tokens are snapshot-local and must be refreshed after every observation.

After a delivered action:

1. Mark the target pending. Do not classify or click it again while pending.
2. Take a fresh overview and check the expected application change.
3. Mark it confirmed only when the application evidence supports that state.
4. If the change remains unconfirmed within the chosen bound, stop for inspection. Do not click again to make verification easier.

If every target is completed, leave the detection loop and inspect the next required control. Do not keep scanning completed targets. Reset the map only after a verified new round or screen, and count that reset against the attempt budget.

## Stop instead of replaying

Stop on a refusal, unknown action result, lost window, changed layout, missing required controls, contradictory UI/pixels, classifier error or exhausted budget. A classifier error is not false. Branch explicitly on `value === true`, `value === false` and `value === null`.

Native pixels can lag the UI. Repeated frame hashes are not automatically failure, but a stagnant screen plus no verified progress must reach the no-progress exit. Do not use a foreground raise as a freshness guarantee.

Use background input first. After an actual background refusal, get a fresh observation before explicitly choosing foreground. Never blindly replay an unknown or completed action.

User cancellation ends the run. Do not catch cancellation and restart. Codemode stores commit only when the script succeeds; an aborted script can lose its state updates even though native input happened. On resumption, recover the current application state from a fresh overview and treat any unfinished action as uncertain. Never reconstruct eligibility merely from an old store.

On a normal early stop, return successfully with the bounded summary so compact state can persist. On timeout or cancellation, do not claim that normal cleanup or final state persistence happened. Release only task-owned resources when appropriate; `computer_close` does not close app windows. Do not delete source images, user documents or model assets as cleanup.

## Return one small summary

Build the result from an explicit allowlist, not by spreading a tool result:

```js
// @options: {"max_output_tokens": 400, "timeout_ms": 30000}
// The bounded observation/classification/action loop stays private.
// At the end, publish only counters and the verified stopping reason.
text({
  stop: "budget", // Or verified success, no_progress, unknown_action, etc.
  frames: 12,
  classifications: 30,
  confirmedActions: 2,
  pendingActions: 0
});
```

The numbers above illustrate the summary shape, not a claimed run. Keep error summaries short and sanitized; do not print a raw exception that may contain an image or a large tool result. A summary must distinguish delivered actions from application-confirmed actions and numerical unknown from tool failure.

## Verify through behavior

Check the skill with real bounded runs, not tests that assert its wording. Useful cases are: a target stays visible after selection; every predicate stays false; repeated unknowns; an interrupted action; and an intentionally exhausted budget. Check that the program exits, completed targets are skipped, and no intermediate payload reaches the agent.

For Whack-a-Mole, keep the existing game progress. Inspect the whole board, track selected cells, classify only unselected cells, verify each selection, and stop when the next level is visibly reached. Respect the user's attempt limit. Passing one level is evidence for that run, not general classifier accuracy.
