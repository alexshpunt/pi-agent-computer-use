# GIMP painting demo

A Pi agent paints a copy of [`assets/draw_task.png`](../../assets/draw_task.png) in GIMP on another Windows machine while the screen is recorded. The result is a sped-up video, a short animated preview for the main README and a side-by-side comparison of the reference and the painting.

| File | Purpose |
| --- | --- |
| [`prompt.md`](prompt.md) | The task the agent gets |
| [`skill/SKILL.md`](skill/SKILL.md) | `paint-from-reference`: how to paint a reference in stages, with verified GIMP techniques |
| [`run.ts`](run.ts) | Prepares the machine, records the screen, runs the agent and cleans up |
| [`postprocess.ts`](postprocess.ts) | Makes the time-lapse, the preview and the comparison from a recording |
| [`gallery.ts`](gallery.ts) | Adds a finished run to the [gallery](gallery/README.md) and the thumbnails in the main README |

## What a run does

1. Moves the user's Windows session from Remote Desktop to the physical console, because a Remote Desktop session takes its resolution from the client. The Remote Desktop connection drops; reconnect after the run.
2. Sets the primary display to 1920×1080.
3. Starts GIMP with an empty 1200×800 canvas, maximizes it and brings it to the front.
4. Records the display without the taskbar with ffmpeg's Windows Graphics Capture at 10 fps.
5. Runs Pi with the prompt, the `computer-use` and `paint-from-reference` skills and no other skills, context files or MCP servers. Tools that ask the user or generate images are excluded.
6. Stops the recording, closes GIMP once the painting is exported and restores the display resolution.
7. Encodes `timelapse.mp4` (120 s) and `preview.webp` (30 s) on the Windows machine, both with the reference in a corner, and builds `comparison.png`.

Outputs go to `.tmp/gimp-demo/<run>/` in the repository: the videos, `painting.png`, the full `recording.mkv`, the agent's `events.jsonl` and its Pi session.

To publish a run, add it to the [gallery](#gallery).

## Requirements

- Pi in WSL on the controlling machine with this extension installed and a login for the chosen model.
- A Windows machine with WSL reachable over SSH, set up as described in [Other machines](../../docs/setup.md#other-machines), with GIMP 3 (`winget install GIMP.GIMP.3`) and ffmpeg 8 or newer (`winget install Gyan.FFmpeg`). GIMP must not be running.
- On that machine, a task that returns a disconnected Remote Desktop session to the console, such as one running `tscon <session> /dest:console` as SYSTEM on disconnect. Without it, sign in on the console before the run.

## Run

```bash
node demo/gimp-painting/run.ts --ssh zinpc-benchmark --machine zinpc
```

| Option | Default | Meaning |
| --- | --- | --- |
| `--ssh` | `zinpc-benchmark` | SSH alias of the Windows machine's WSL |
| `--machine` | `zinpc` | Machine name the agent uses in `computer:` addresses |
| `--model` | `openai-codex/gpt-6.1-terra` | Model for the agent |
| `--thinking` | `high` | Thinking level |
| `--reference` | `assets/draw_task.png` | Picture to paint |
| `--canvas` | `1200x800` | Canvas size; keep the reference's aspect ratio and fit it at 100% zoom |
| `--display` | `1920x1080` | Display resolution during the run |
| `--max-minutes` | `240` | Time limit for the agent |
| `--prepare-only` | off | Set the display and open GIMP, then stop: no recording, no agent, nothing restored. For trying the skill by hand |
| `--video-seconds`, `--preview-seconds` | `120`, `30` | Lengths of the time-lapse and the preview |

To redo the videos of an earlier run, pass its Windows folder, which `run.ts` prints at the end:

```bash
node demo/gimp-painting/postprocess.ts --ssh zinpc-benchmark --remote-dir 'C:\Users\user\pi-gimp-demo\<run>' --out .tmp/gimp-demo/<run>
```

## Gallery

[gallery/](gallery/README.md) keeps one folder per run: a thumbnail of the painting, the painting next to the reference and `run.json` with the model, thinking level, date, time, cost, counts and the video URL. `gallery.ts` reads the model, time and cost from the run's Pi event log and writes the gallery page and the thumbnails between the `gimp-gallery` markers in the main README. Don't edit those generated parts by hand.

To add a run:

1. Add it from its output folder. `--feature` also makes its preview the animation at the top of the main README.

   ```bash
   node demo/gimp-painting/gallery.ts add .tmp/gimp-demo/<run> [--feature]
   ```

2. Upload the run's `timelapse.mp4` to GitHub: open any issue or pull request form on github.com, drag the file into the comment box or click "Paste, drop, or click to add files", copy the `https://github.com/user-attachments/assets/...` URL GitHub inserts and leave the page without posting. GitHub plays only these URLs as videos in a README, and it has no API for the upload.

3. Store the URL:

   ```bash
   node demo/gimp-painting/gallery.ts video <run id> https://github.com/user-attachments/assets/<id>
   ```

`gallery.ts render` rebuilds the page and the README block from the `run.json` files.
