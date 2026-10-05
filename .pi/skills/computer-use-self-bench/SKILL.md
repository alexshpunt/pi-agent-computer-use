---
name: computer-use-self-bench
description: Play Neal's Not a Robot game to test computer use. Continue until a level fails after five attempts, then analyze the session for agent mistakes, unclear skill instructions, tool ergonomics and missing or broken tool capabilities.
---

# Computer-use self-bench

Read [Computer Use](../computer-use/SKILL.md). Follow its **observe → inspect → plan → act → observe** loop throughout the game.

## Start the game

Open https://neal.fun/not-a-robot/ in a task-authorized browser window using the `computer_*` tools. Start at the first level for a new run. If the user asks to resume, observe the existing game and continue from its current state. Do not reset a paused game without a request for a fresh run.

Use only the visible game UI and the current computer-use tools. Read puzzle answers from the returned images. Accessibility elements can identify controls, not supply hidden answers. Do not read game source, hidden DOM state, scripts, network responses or walkthroughs. Do not use another backend to bypass a missing operation.

## Play until blocked

1. Read the level's instruction and small whole-window overview.
2. Choose the areas needed to solve it and inspect them in one Codemode batch.
3. Decide on an answer and plan the supported action sequence.
4. Apply the sequence through Codemode and observe the result.
5. Count the level as passed only when the next level or an explicit success state is visible. Continue immediately to the next level.
6. After a failed attempt, inspect what actually happened. Correct the reasoning or interaction approach before trying again.
7. Stop playing after **five unsuccessful attempts on the same level** and start the reflection loop. Reset the attempt count when a level is passed.

An attempt is a complete answer submission or a deliberate interaction sequence intended to solve the level. Screenshots, zooms and individual clicks within one sequence are not separate attempts.

Make each retry a reasoned attempt, not a blind repeat. Try the most likely reading even when text is uncertain. Do not leave an answer blank merely because it is hard to read.

A refusal is not proof that an answer was wrong. An unknown action may already have taken effect: observe before deciding what happened and never replay it blindly. If a required operation cannot be performed safely with the available tools, stop and analyze that blocker rather than manufacture five unsafe retries.

Keep track of the current level, attempted answers/actions and observed outcomes so the session can be analyzed. Five failures mean the run is blocked at that level, not that the level is universally impossible.

## Reflection loop

Stop game input. Review the session's actual instructions, observations, chosen targets, Codemode batches, action outcomes and submissions. Read the current Computer Use skill again; do not judge it from memory.

For each failed attempt:

1. Reconstruct what the agent saw, what it decided, which actions ran and what changed.
2. Find the first point where the observed result diverged from the plan.
3. Classify the cause using the checks below. More than one cause can apply.
4. Check the explanation against the session evidence and the actual tool contract. Reject explanations contradicted by the evidence.
5. Identify a specific correction and how it would be verified. Repeat the analysis until each failure has an evidence-backed explanation or an explicitly unresolved cause.

### Did the agent follow the skill?

- Did it first establish the current environment from a whole-window overview?
- Did it inspect small or uncertain areas before deciding?
- Were planned observations grouped in one Codemode batch?
- Were known actions applied sequentially through Codemode?
- Were element tokens, image coordinates and app observations fresh and correctly scoped?
- Did it check the actual result before retrying or advancing?
- Did it stop a partial batch on failure without replaying completed actions?

If the skill clearly explained a rule and the agent ignored it, record an agent mistake. Do not call that a missing tool capability.

### Was the skill unclear or incomplete?

Find the exact instruction that was ambiguous, misleading or missing. Explain which decision it failed to support. Propose a concrete wording change or a small example, not a general expansion of the skill.

Separate a missing explanation from an instruction the agent simply did not read or follow.

### Was the tool awkward to use?

Identify avoidable round trips, repeated captures, cumbersome target selection, confusing parameters or output that made the next decision harder. Show where the workflow became awkward and what a simpler interaction would preserve.

A supported but inconvenient operation is an ergonomics issue, not an absent capability.

### Did a tool prevent progress or behave incorrectly?

Name the required operation and the public tool that was tried. Compare its documented contract with the actual input, output and UI effect.

Distinguish:

- **Missing capability:** the required operation is not exposed and no supported equivalent solves the task.
- **Tool defect:** a valid, grounded call behaved contrary to its contract.
- **Guard or delivery refusal:** the call was rejected because its target, permission or grounding was invalid or unavailable.
- **Unverified state:** pixels, semantics or action outcomes did not establish what happened.

Do not turn a stale target, wrong coordinate space or uncertain screenshot into a tool-defect claim without evidence.

### Was it a reasoning error?

If the intended input visibly took effect but the puzzle rejected the answer, inspect the interpretation and answer itself. Wrong selections, misread characters and incorrect puzzle logic are agent errors unless evidence shows otherwise.

## Finish the analysis

State the blocked level and the five attempts, or the concrete earlier tool blocker. For each issue, give the evidence, cause, proposed correction and verification step. Keep agent mistakes, skill changes, ergonomics improvements, missing capabilities and tool defects separate.

Do not automatically change the tool contract or implement new capabilities as part of the analysis. If a correction is applied, retry the blocked level with a new five-attempt cycle and check whether that specific problem was resolved. Do not restart an unchanged run without a new explanation or approach.
