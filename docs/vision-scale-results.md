# Agent image size: results

Historical pre-CUA route. Its code, runners and dependencies were retired by LPT-396; revision-linked results remain evidence, not current API guarantees. Use [the native CUA browser contract](browser.md) for current actions, scaling and fresh zoom.

[LPT-375](https://linear.app/alexshpunt/issue/LPT-375) adds physical PNG resizing and the local reading trial. The user chose **MKS2021, maximum long edge 500 px, scale 1** for the owned-browser overview. General desktop/display images and per-request crop scale remain separate work.

## What passed

- Four real Sharp 0.35.5 kernels, aspect-ratio fit, no enlargement and bounded original PNG retention. Each resize starts from captured source pixels, not a previously reduced image.
- Atomic session settings, frozen in-flight configuration, source CSS point mapping and reset to the selected default. The 500px regression also catches a floating-point calculation that used to waste one pixel on a 1201px source.
- Debug dropdown, long edge, slider and synchronized exact scale input. The trial has two columns of six independent random strings, twelve text inputs and no confidence fields. Apply compares exact strings, keeps grades and starts fresh text.
- Working checkout: 70 unit tests, typecheck and five real-Pi integration contracts. Native overview/control check and twelve-field GUI check passed; their owned browsers, workers and profiles were removed.
- After reload, parent Pi received MKS2021/500/scale1/version0 and a real **500×325 PNG**, from a 1085×706 source. The actual viewer controls matched. Human TUI checked in Herdr `w3E9:p6`, revision 2371. Collapsed output hides images; the browser viewer is the visual preview.

See [default verification](evidence/vision-scale/default-verification.json) and [native default image](evidence/vision-scale/native-default-500.png).

## Reading at 400 px

Model: `openai-codex/gpt-6.1-sol`. Every trial used fresh random text, the same 1085×1287 source viewport and a 337×400 agent PNG. All twelve fields received a best-effort answer, including speculative fine text. Answers came from the processed screenshot only: no original-image reading, OCR or DOM answer text.

| Kernel | Exact matches | Rows matched |
| --- | ---: | --- |
| Lanczos2 | 6/12 | 1–3 on both backgrounds |
| Lanczos3 | 6/12 | 1–3 on both backgrounds |
| Mitchell | 6/12 | 1–3 on both backgrounds |
| MKS2021 | 7/12 | 1–3 on both backgrounds, plus dark row 5 |
| MKS2021, fresh repeat | 7/12 | 1–3 on both backgrounds, plus light row 5 |

Row 4 did not match with any kernel. MKS2021 showed a small signal, not a statistically established win. Text differed between trials. The user's default choice is a product decision, not a claim that this kernel always wins.

[Attempts, actual grades, image hashes and configuration](evidence/vision-scale/kernel-reading-400.json), and [the five actual returned PNGs](evidence/vision-scale/reading-400/). These PNGs were recovered from recorded Pi results after grading and checked against the recorded hashes.

## Scale boundary

The earlier Lanczos3 sweep scored 12/12 at 800, 8/12 at 500, 6/12 at 400, 4/12 at 300, 2/12 at 200 and 0/12 at 150. **Some smaller-trial fields were left blank. These are not full-effort reading scores.** The source viewport also changed between the 800px and smaller views, so that transition is not a controlled size comparison.

After the user corrected the protocol, a fresh 150px trial received guesses in all twelve fields. It scored **0/12**, including both largest strings, at an actual 126×150 PNG. This records failed exact transcription, not proof of zero understanding. The 400px comparison above also filled all fields.

[Raw attempts, including the documented earlier blanks](evidence/vision-scale/scale-limit-attempts.json), and [the all-fields 150px retry](evidence/vision-scale/all-fields-150.json). A 500px overview still loses small text; closer views are needed. No universal safe threshold is claimed.

## Pixel and processing benchmark

One graded source was resized offline with four kernels at caps 800, 600, 400 and 200. The original was exported only after answers had been graded. Each candidate had one local processing warm-up and five measured runs. No model calls or model/cache warming were used.

| Kernel | PNG bytes at 800 | Median processing ms at 800 | PNG bytes at 400 | Median processing ms at 400 |
| --- | ---: | ---: | ---: | ---: |
| Lanczos2 | 97,700 | 14.97 | 34,653 | 10.05 |
| Lanczos3 | 109,395 | 14.12 | 40,166 | 10.55 |
| Mitchell | 95,728 | 15.60 | 33,886 | 11.00 |
| MKS2021 | 105,403 | 14.51 | 38,243 | 12.60 |

The source PNG was 76,366 bytes: spatial reduction can increase PNG bytes. These timings measure decode, resampling and PNG encoding, not model thinking, browser input, network latency or an end-to-end speedup.

[All sixteen measurements](evidence/vision-scale/benchmark.json), [graded original](evidence/vision-scale/original-graded.png), and [candidate PNGs](evidence/vision-scale/pixels/). The JSON's temporary source path records where the run happened; the same source hash is retained in the linked original.

## Limits

The viewer observes application-hook bytes. Final provider delivery and internal model preprocessing remain unconfirmed. Retained originals can already contain hint overlays. Existing region mapping is covered internally, but the broader crop backend and per-request scale API are not delivered here. No IDE, cache, desktop policy, personal browser or persistent machine setup was changed.

A clean export of the selected Git index passed **63 unit tests, typecheck, five real-Pi integration contracts, the 16-operation native full-frame/control check and the 23-operation native trial check**. Both native runs removed all owned browser/worker/profile resources. The runner refreshes hints after observations and requests captures explicitly, so it does not depend on unfinished stable-hint or default-action-capture changes. Unfinished browser follow-up changes remain outside this task's commit.
