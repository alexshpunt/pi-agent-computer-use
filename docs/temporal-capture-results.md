# Temporal capture results

Verified on Windows from WSL on 7 October 2026 for [LPT-616](https://linear.app/alexshpunt/issue/LPT-616). This covers native windows, including browser windows, and the primary display. It does not claim support for another platform or capture backend.

## Environment and native contract

The installed runtime stayed on the qualified Windows key-hold fork `3b330504`. No driver upgrade, new backend, ffmpeg install, Pi core change or IDE change was needed. CUA main source was inspected at `a7524cfd1d3e959963b43954d43f27c4bd260f08`; recent release source was also reviewed. Window sampling uses `get_window_state` with `include_accessibility_tree:false`, not a repeated accessibility walk. Display sampling uses the existing native primary-display route.

After a WSL restart removed the configured interop socket, the user approved changing only the ignored local config's interop path from `/run/WSL/401_interop` to `/run/WSL/350_interop`. The runtime command and all other settings stayed unchanged.

## Automated checks

- Full unit suite: **240 tests across 25 files**, with two workers.
- Related real-Pi integration set: **6 checks across 5 files**. This includes the temporal tool through the real extension loader and Codemode: metadata-only capture, three retained frames, and exactly two explicitly forwarded selected images.
- TypeScript typecheck passed.
- Timing tests cover slow captures, skipped slots, no catch-up bursts, frame caps, cancellation and exact selection order.
- Session tests cover Safe display denial before native dispatch, access revocation, window replacement, movement/resize geometry, fixed-region clipping, timeout recovery and retired overview input.
- Viewer tests cover all temporal payload images rather than only the ordinary three cards. A live-discovered duplicate provenance bug has a regression check: selecting the same sequence/index twice produces one source match; identical pixels at different indexes still remain ambiguous.

These are behavior checks, not assertions about skill wording. Safe/revocation, replacement, resize and timeout were checked deterministically; they were not all repeated live on Windows.

## Live native timing

The tracked `scripts/verify-temporal-capture.mjs` uses an isolated disposable Chrome profile and the local synthetic fixture. It measures native timing and keeps the fixture open for production-tool checks:

```sh
node --experimental-transform-types scripts/verify-temporal-capture.mjs
# Send finish on stdin after production checks.
```

Initial runs requested three seconds at the existing 500px native cap:

| Source | Requested FPS | Frames | Measured FPS | Elapsed ms | Skipped slots | Image bytes |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Window | 4 | 6 | 2.069 | 2827.5 | 6 | 169255 |
| Window | 10 | 9 | 2.882 | 3093.6 | 21 | 253747 |
| Primary display | 4 | 4 | 1.364 | 2905.4 | 8 | 226149 |

Window native-call latency was 295.3–375.5ms at requested 4 FPS and 273.2–304.8ms at requested 10 FPS. Display latency was 624.3–704.2ms. Frame intervals were 466.7–503.4ms, 287.3–418.1ms and 678.1–773.3ms respectively. Every frame hash changed; pending slots were zero. Initial window rasters were 318×500 and display rasters 499×333.

A native cancellation requested after 650ms returned at 656.4ms with one completed prefix frame. A subsequent bounded capture succeeded. No ongoing sampling loop remained.

## Production tools after reload

The extension was reloaded and checked through the registered production tools, not just a direct session fixture.

- A three-second window request at 4 FPS returned **12 frames, 3.9945 measured FPS, no skipped slots, 582306 image bytes**. Intervals were 226.8–277.2ms; raster size was 500×439.
- After the final viewer fix and another reload, the same request returned **12 frames, 4.0073 measured FPS, no skipped slots, 657437 image bytes**. Native completion timestamps ran from 105.8ms to 2850.8ms.
- Capture returned metadata only. All twelve frames were then explicitly forwarded with index/timestamp labels through Codemode. They showed movement, color changes, changing/wrapping progress and a toast appearing and disappearing.
- Metadata-only selections returned endpoints `[0,11]`, indexes `[1,3]`, inclusive range `[1,2,3]` and all twelve byte-changed frames without forwarding extra images.
- A crop chosen from an observed overview used `{x:15,y:150,width:320,height:150}`. The 1.5s run produced six frames at 3.7958 FPS and 21203 bytes. A 1.2s run produced five at 4.0333 FPS and 16570 bytes. Forwarded endpoints showed the expected moving block, progress and toast. Requested/applied crop metadata matched; native origin remained honestly unknown when CUA did not provide the original raster dimensions.
- A harmless Escape request using the pre-sequence overview was refused as stale before input dispatch. Selected frames reported `input:none`.

The different timing results show why requested FPS is only a sampling goal. These are individual live measurements, not a controlled throughput benchmark or a promise of 4 or 10 FPS on another workload.

## Human viewer and TUI

Only the authorized disposable Chrome window was used for the debug viewer. Native screenshots showed the temporal dropdown with `Payload 0 · frame 0 @ 105.8 ms` and, after selecting the last entry, `Payload 11 · frame 11 @ 2850.8 ms`. The displayed fixture image changed with the choice. The metadata panel showed the last frame's index, timestamp, hash, payload path and availability.

All twelve viewer asset hashes matched the original stored frame hashes, and their downloaded PNG bytes passed SHA-256 comparison. The latest debug boundary contained twelve temporal image blocks in order even after another selection of indexes 0 and 2 without `image(...)`. Every source match was unique after the duplicate fix. Ordinary screenshots already in Pi context explain why the request's total image count was greater than twelve.

`inspect_tui` captured the actual Herdr pane `w3MD:p1`, 161×57 cells, at revisions 157 and 158 after the final reload. The completed endpoint result was readable, with indexes 0/11, timestamps 105.8/2850.8ms, `input:none` and zero forwarded images. No base64 payload appeared in the visible result. Long verification commands wrap in the terminal; they are not a new custom renderer.

This is evidence at Pi's existing application/provider-hook boundary. **Final wire delivery and provider-side image processing remain unconfirmed.**

## Cleanup and limits

The owned Chrome window was closed through its observed native Close control; discovery confirmed it was gone. Its unique disposable profile was removed, the local fixture server exited, and computer-use runtime references were released. The initial holding terminal disappeared in the WSL restart, so its scripted cleanup receipt could not be recovered; final cleanup was checked separately.

Frames are session-local and read-only. They do not survive close/reload or authorize input. Store limits count decoded image bytes; base64 and metadata add memory. Timestamps mean native-call completion, not compositor presentation or proven paint freshness. Byte-based `changed` selection does not claim semantic relevance. CPU/GPU costs, model comparisons, continuous monitoring, video encoding, other displays and sandboxes remain outside this task.
