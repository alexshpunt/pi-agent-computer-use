# Task-success benchmark (LPT-838)

A small, repeatable WindowsAgentArena-style suite. It gives a comparable success rate for computer use as a whole: model, skill, IDE tools, this extension and the CUA driver together.

## How it works

- Ten tasks in [bench/windows-tasks.ts](../../bench/windows-tasks.ts) use only apps that Windows Sandbox ships with: Command Prompt, Windows PowerShell, File Explorer, Registry Editor and Microsoft Edge on two local synthetic pages.
- Each task runs as a separate trial of a real Pi agent through [pi-coding-agent-eval](https://www.npmjs.com/package/pi-coding-agent-eval). The agent loads Pi Agent IDE, this extension and the computer-use skill, and nothing else. It connects to the configured machine, opens a new Windows Sandbox with the trial's input folder (`C:\pi\import\input`) and an empty output folder (`C:\pi\export`), and works only inside it.
- A task passes when the output folder holds the expected file, or when the agent's final `ANSWER:` line matches. The checks have unit tests in `test/windows-tasks.test.ts`.
- A trial has 20 minutes. A timeout fails that task only. Afterwards the suite removes the trial's folders and closes any sandbox the agent left open.

Run it with `npm run bench:windows -- [--model provider/id] [--thinking high] [--task <id>] [--machine lab]`. Model and thinking default to Pi's own settings. Results go to `.tmp/bench/results`, with a Markdown table per run.

## Results

A Windows 11 25H2 test machine with a 4K console, model `openai-codex/gpt-5.6-luna`, thinking high, 2026-10-20. Times are seconds, tokens are input plus output.

### Baseline: runtime fb7d1909

| Task | Passed | Time | Tool calls | Tokens | Note |
| --- | --- | --- | --- | --- | --- |
| cmd-write | yes | 105 | 16 | 438,107 | |
| explorer-folders | yes | 179 | 35 | 1,378,981 | |
| explorer-copy | no | — | — | — | timed out after 20 min in a copy, paste and rename loop |
| explorer-largest | yes | 157 | 29 | 1,114,455 | |
| count-files | yes | 92 | 15 | 398,913 | |
| powershell-hash | no | — | — | — | timed out: typed text never reached PowerShell |
| regedit-read | yes | 211 | 42 | 2,183,516 | |
| regedit-export | no | — | — | — | timed out while creating the value and exporting |
| edge-form | yes | 221 | 32 | 1,594,968 | |
| edge-table | yes | 138 | 17 | 595,862 | |

7 of 10 passed. Passing tasks took a median of 157 s and 1.1 M tokens.

### After the fixes: runtime 9921ae54

| Task | Passed | Time | Tool calls | Tokens | Note |
| --- | --- | --- | --- | --- | --- |
| cmd-write | yes | 92 | 18 | 500,269 | |
| explorer-folders | yes | 228 | 55 | 2,491,103 | |
| explorer-copy | yes | 221 | 51 | 2,673,465 | was a timeout |
| explorer-largest | yes | 114 | 22 | 694,714 | |
| count-files | yes | 91 | 14 | 371,346 | |
| powershell-hash | yes | 186 | 21 | 647,950 | was a timeout; needs the keystroke typing fix |
| regedit-read | no | — | — | — | timed out after 20 min |
| regedit-export | no | — | — | — | timed out after 20 min |
| edge-form | no | — | — | — | timed out after 20 min (passed in the baseline) |
| edge-table | yes | 101 | 18 | 577,768 | |

7 of 10 passed again, but the set changed: the two tasks the fixes targeted now pass, and three others timed out. With one attempt per task the numbers are noisy. Use `--task` to repeat one task, and compare runs over several attempts before drawing a conclusion. All five timeouts across both runs ended the same way: the agent's turn stopped and Pi waited without continuing until the 20-minute limit. The step that went wrong differed from run to run.

### Model comparison on runtime 9921ae54

Same tasks and runtime, thinking high, one attempt each.

| Task | gpt-5.6-luna | gpt-6.1-sol: time / calls / tokens | claude-opus-5-5: time / calls / tokens |
| --- | --- | --- | --- |
| cmd-write | yes | yes, 103 s / 17 / 0.48 M | yes, 111 s / 13 / 0.57 M |
| explorer-folders | yes | yes, 278 s / 61 / 2.62 M | yes, 220 s / 32 / 1.99 M |
| explorer-copy | yes | yes, 206 s / 43 / 1.54 M | yes, 200 s / 38 / 2.75 M |
| explorer-largest | yes | yes, 165 s / 31 / 1.00 M | yes, 149 s / 25 / 1.43 M |
| count-files | yes | yes, 97 s / 12 / 0.31 M | yes, 85 s / 11 / 0.46 M |
| powershell-hash | yes | yes, 127 s / 14 / 0.38 M | yes, 132 s / 15 / 0.69 M |
| regedit-read | no | yes, 123 s / 19 / 0.55 M | yes, 109 s / 15 / 0.71 M |
| regedit-export | no | yes, 314 s / 69 / 3.12 M | yes, 475 s / 69 / 4.99 M |
| edge-form | no | yes, 125 s / 18 / 0.59 M | yes, 125 s / 21 / 1.13 M |
| edge-table | yes | yes, 129 s / 14 / 0.41 M | yes, 146 s / 22 / 1.25 M |

`openai-codex/gpt-6.1-sol` and `anthropic/claude-opus-5-5` each passed 10 of 10; Luna passed 7. Median per task: Sol 128 s and 0.57 M tokens, Opus 140 s and 1.13 M tokens. Neither hit the timeout, so the Luna timeouts point to the model, not to computer use. regedit-export (create a key and value, then export through a dialog) is the longest task for every model.

Claude models run through the installed `pi-claude-subscription-connector`. The runner loads it for `anthropic/*` models, because trials run without the user's Pi packages and Anthropic would otherwise bill extra usage.

## What the benchmark found

The first trials found product bugs. They were fixed before or between the runs above:

- **Windows Sandbox did not start on the test machine.** Since the October 2026 Windows updates, fresh guests enforce Smart App Control, which blocked the unsigned driver. Guest setup now turns it off inside the disposable guest only.
- **A second sandbox waited 120 s and timed out.** Windows runs one sandbox at a time and only shows an error dialog. `open_sandbox` now refuses at once, and closing also ends the sandbox client, since `wsb stop` can fail over SSH.
- **`Enter`, `ESC` and `-` were "Unsupported key".** Key names now ignore case, accept common spellings and unshifted punctuation, and an unknown key lists the valid names.
- **Typed text never reached Windows PowerShell.** PSReadLine ignores Unicode (`VK_PACKET`) input. The driver now types characters on the target's keyboard layout as real keystrokes (fork 9921ae54). In an A/B sandbox check, the previous runtime showed pressed keys but no typed text, and the new one showed both.

Where the time goes: a sandbox window Read took 0.5–1 s, input under 1 s, `connect` about 15 s and `open_sandbox` about 30 s. Most of each trial was the model's own turns, about 10 s each. Long UI chains, such as copy, paste and rename in File Explorer or creating and exporting a registry value, used many single-step turns and ran out of time.
