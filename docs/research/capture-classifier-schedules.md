# Capture and classification schedules for short-lived targets (LPT-702)

Which schedule of capture, classification and input catches a target that is visible only briefly? This compares a plain serial loop, five-frame bursts, a pipeline that classifies only the newest frame, and a pipeline that classifies every frame. It also checks parallel capture and how soon a frame shows an action's effect.

## Setup

- **Machine and page.** A Windows 11 test machine, owned Edge window on a synthetic page (`/flash` in `scripts/web-fixture.mjs`). The page shows a 60 px red square at a random spot every 1.5 s, for 600 ms or 400 ms. It journals each appearance, each hit with its reaction time from appearance to `pointerdown`, and each miss.
- **Detection.** The local TinyCLIP classifier (`computer_classify`'s model) looks at a 4×4 grid of the 640 px overview in one batch. The threshold of 0.24 was calibrated on this page: about 0.26 on the square's cell and 0.21 elsewhere. The click goes to the red pixels inside the chosen cell. One capture takes 40–90 ms, one batch 75–170 ms.
- **Input.** A foreground pixel click through the latest observation.
- **Test.** `test/live/reaction-schedules.live.ts`, 30 s per schedule. `FLASH_MS`, `RUN_MS` and `REACTIVE` select the variant.

## Results

With `animation:"reactive"` (1 ms cursor glide):

| Schedule | Hits at 600 ms | Hits at 400 ms | Reaction p50 | Frame age at click p50 |
| --- | --- | --- | --- | --- |
| Serial: capture, classify, act | 15 / 21 | 14 / 21 | 240–250 ms | 75–80 ms |
| Pipelined, newest frame only | 14 / 21 | 16 / 21 | 255–290 ms | 110 ms |
| Burst of five, then classify all | 3 / 22 | 0 / 21 | 547 ms | 360–370 ms |
| Pipelined, every frame in order | 5 / 21 | 1 / 22 | 363–575 ms | 490 ms |

Other measurements:

- **The effect of an action shows in the next frame.** A click that flips a page block was visible in the first frame captured afterwards, 52 ms p50, in 15 of 15 rounds.
- **Parallel captures do not help at this speed.** Four captures of one window together took 217–353 ms, against 201–385 ms one after another. One earlier run showed 2× from parallel capture, while each capture was slower.
- **The cursor glide dominated at first.** By default CUA waits for the visible agent cursor to glide to each new point before it clicks. A click on a new spot took 650–930 ms, a repeat click on the same spot 115 ms, and with the 1 ms reactive glide 155–175 ms. With the default glide, every schedule caught 0–1 of 21 targets. Remote machines and sandboxes could not use the reactive glide until this task, because their drivers were not wrapped. They now are.

## Conclusions

- **Use a serial loop, or capture ahead and classify only the newest frame.** Both catch about two thirds of 400–600 ms targets. Bursts and per-frame queues act on frames that are hundreds of milliseconds old and miss.
- **Always use `animation:"reactive"` for reaction loops.** The glide, not capture or classification, was the largest delay.
- **No new capability is needed.** Classification throughput is not the limit: newest-only skipped about a third of its frames without losing hits. No burst or parallel capture API is proposed.

The skill `reactive-visual-classifier` carries these rules.
