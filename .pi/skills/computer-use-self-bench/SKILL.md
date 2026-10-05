---
name: computer-use-self-bench
description: Run an honest live self-benchmark of computer use on Neal's Not a Robot game. Use when the user asks to test the agent's browser skills, replay the game, compare interaction workflows or see how far the agent can get.
---

# Computer-use self-bench

Use https://neal.fun/not-a-robot/ as the live benchmark. This is a puzzle game that imitates CAPTCHAs, not permission to solve real access-control challenges elsewhere.

Read [Computer Use](../computer-use/SKILL.md) and [the owned-browser contract](../../../skills/owned-browser-use/SKILL.md) first. Use the current Pi tools and CUA only. Do not start another agent, another backend or a paid model matrix.

## Start or resume

- Follow the user's requested starting point. For a fresh run, open the game in one new isolated owned browser. If an owned browser already exists, observe it before choosing a reset or close. Do not navigate to the same URL just to refresh.
- Do not touch personal browsers, profiles, accounts or unrelated windows. YOLO does not broaden browser ownership.
- Record the model, current tool/runtime version, overview size and whether the run is fresh or resumed. Keep unavailable values unknown.
- Record the initial visible level before the first input. Old runs do not count as this run's progress.
- Keep a checkpoint in the ignored `.tmp/` directory while playing. At a pause, interruption or tool failure, record the last visibly passed level, current level and which inputs already ran. Put reusable reports in the repository rather than leaving them only in temporary storage.

## Play through the visible UI

1. Read the instruction and actual returned image. Semantic text/hints can identify visible controls, but must not supply a hidden puzzle answer.
2. If a string or target is too small, use a grounded zoom from the latest overview. Read the returned pixels yourself.
3. Reason about the puzzle. Enter the most likely reading even when some characters are uncertain; do not leave answers blank merely because they are difficult. Do not invent confidence scores unless the user requests them.
4. Use current semantic hints for known independent actions. Await them in Pi Codemode with `observe:false`, then observe at the next decision point. A sequence stops at the first refusal or unknown outcome; completed inputs are not replayed.
5. For coordinate actions, ground each point in the latest returned image. A capture-free pixel click consumes that image context; get a new image before another pixel action. Do not batch guessed coordinates or reuse a zoom after an overview.
6. Verify the selection or entered value before submitting when the puzzle allows it. After submission, count a pass only when the next level or an explicit success state is visible.
7. Continue through levels until completion, the user's stop/pause, or a concrete unresolved blocker. Do not stop automatically after each passed level.

Never inspect game source, scripts, network responses, local storage, hidden DOM state or answer-bearing image metadata. Do not use OCR, walkthroughs, external solutions or remembered answers from earlier runs. Generic accessibility control discovery is allowed. The challenge is the agent reading and operating the UI.

## Separate failures

- **Reasoning:** the input visibly took effect, but the selected answer was wrong. Inspect the puzzle again and try a reasoned correction. This is not automatically a missing tool capability.
- **Delivery:** the tool refused before input, returned unknown, or the intended change was not observed. Observe before deciding what happened. Do not replay unknown input.
- **Freshness:** pixels and semantics disagree. Use bounded read-only observations, not repeated clicks to force a repaint. A successful capture, delay or foreground raise does not prove paint readiness.
- **Capability:** an actually needed operation is absent from the current public tools. Record the operation and evidence. Do not switch to Playwright, raw CDP, page JavaScript, global OS input or a patched Driver to finish the level.

Do not change the extension in the middle of a scored run and present the result as one unchanged baseline. If the user asks for a fix, checkpoint the run and report the before/after runs separately.

## Timing and evidence

For a timed puzzle, prepare only the visible targets already observed and batch deterministic supported actions where possible. Do not preload hidden future targets or interpret tool latency as model reasoning latency.

Record per level:

| Field | Record |
| --- | --- |
| Level / puzzle | Actual visible label |
| Attempts | Submissions and reasoned corrections |
| Outcome | Passed, failed, paused or blocked |
| Observation | Overview/zoom used and visible result |
| Tool calls | Actual calls; separate capture-free actions from observations |
| Timing | Measured timestamps/elapsed time only; unknown if not captured |
| Issue | Reasoning, delivery, freshness or missing capability |

Do not call a run complete because an action returned success. Do not fabricate token, cost, latency or accuracy numbers. A single game run is not a general model leaderboard or a universal coordinate benchmark.

Use `inspect_tui` when judging what the human sees in Pi. Stock collapsed image attachments do not prove inline pixels were visible. The actual Windows browser, agent cursor and human observation frame are separate from model perception images.

At a user pause, keep the owned browser as requested and preserve the checkpoint. When ending the run, close only its owned browser/session; verify uncertain cleanup before claiming it is closed.

## Report

State the last visibly passed level, current level, attempts, concrete blockers and whether the browser is still open. Separate puzzle mistakes from tool defects. Link any durable evidence, and keep private desktop pixels/text out of Git and Linear.
