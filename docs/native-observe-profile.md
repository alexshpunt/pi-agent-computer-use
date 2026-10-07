# Native observation boundary probes

Run from the repository root with the currently live WSL interop endpoint:

```sh
WSL_INTEROP=/run/WSL/364_interop node --experimental-transform-types scripts/profile-native-observe-boundaries.mjs 10
```

The runner requires the inspected windows-shell-desktops source and its existing hash-qualified runtime. It opens one isolated local browser fixture, performs read-only native calls, checks zero fixture input during samples, and closes its browser/profile, native process and local site. Sample count is 1..20. No installed runtime, persistent config or OS setting changes.

## What is measured

Each timer wraps public native `get_window_state` through the ordinary McpDriver, including transport, SDK parsing and result projection. Pi/Codemode, human frames and adapter lifetime calls are outside this boundary. Setup and output verification are outside warm samples. Order rotates between rounds.

The metadata probe sets both return flags false and verifies the exact native `Nothing to return` error. In source `506239da08cfdafa63dac1857f5471752fb70f5e`, this rejection occurs after window lookup, process enumeration and shell desktop membership, but before the UI walk and capture. It is not a successful screenshot or a valid agent observation.

The file probe keeps PNG generation and writes one exact owned file instead of embedding the image. Windows may report that same file with its canonical extended-path prefix; no different path is accepted. The native-size probe skips resize but transports a larger PNG. These are comparisons, not additive timers inside the native process.

## Observed result

[Redacted evidence](evidence/window-observe-profile/native-boundaries.json): 50 warm probes, ten per variant, all verified. Owned cleanup passed. Native dimensions were 1237×1327; capped dimensions were 466×500.

| Public-call variant | Mean | Median |
| --- | --- | --- |
| Late metadata rejection, no capture/tree | 28.6ms | 22.8ms |
| Image-only, 500px cap, embedded PNG | 126.2ms | 118.5ms |
| Image-only, native size, embedded PNG | 96.0ms | 92.5ms |
| Image-only, 500px cap, PNG file | 118.6ms | 112.6ms |
| UI-only, no PNG | 75.6ms | 67.4ms |

Skipping resize was faster despite the larger PNG. Removing image transport did not remove most latency. Work before capture was measurable too. This narrows the search; it does not prove which internal function dominates.

## Timing-only Windows build (LPT-649)

The user approved a separate diagnostic build, not a runtime replacement or an optimization. [Windows run 37677013717](https://github.com/alexshpunt/cua/actions/runs/37677013717) passed native owner and protocol tests, then built the unsigned diagnostic EXE.

- Installed source: `506239da08cfdafa63dac1857f5471752fb70f5e`.
- Diagnostic source: `6108128403821b6382418c131c3df8654aa35abe` on `diagnostic/windows-observe-lpt649` in the public CUA fork. Only timing wrappers were added.
- Diagnostic EXE SHA256: `1e56928969c22a4eb7281772590b9b6946e43001654deb792e1388a2447610df`.
- Installed EXE SHA256: `0e25c8b83fd48b54be479eb128452a6f6b099b5ff6ce2d20bac024eda07ead16`, checked before and after the run.

`scripts/prepare-native-observe-trace.mjs` generates the patch from immutable pinned source into ignored files. It does not edit the CUA checkout. `scripts/native-observe-trace.rs` records bounded, fixed-label spans. Each observation gets one ordinal and one stderr report after normal stdout delivery. It stores no arguments, window identities or pixels. Concurrent or truncated traces cannot support attribution.

`scripts/profile-native-observe-trace.mjs` verifies the exact artifact source and three EXE hashes, copies it to a temporary Windows folder, and launches it explicitly. Production config is never changed. The runner alternates installed and diagnostic calls on the same owned browser, rotates mode order, and stops on failure without replay. It accepts 1..20 pairs per mode, a three-minute measurement budget and a 15-second timeout per native call.

After downloading the exact build artifact under `.tmp/native-observe-profile/`, run:

```sh
WSL_INTEROP=/run/WSL/364_interop node --experimental-transform-types scripts/profile-native-observe-trace.mjs .tmp/native-observe-profile/build-61081284 10
```

## Measured native stages

[Request-correlated evidence](evidence/window-observe-profile/native-trace.json): 80 warm calls, ten installed/diagnostic pairs per mode, plus eight setup calls. All calls were verified. Both runtimes used the same fixture and dimensions. The saved overview visibly showed only the owned fixture and zero clicks. Sample input count was zero. Browser/profile, both clients, local site and temporary diagnostic files were cleaned. Installed config bytes and EXE hash stayed unchanged.

This fixture was 1555×2448 native pixels and 318×500 capped pixels. The earlier public-boundary fixture was smaller, 1237×1327. Paired geometry stayed fixed within each run, but cross-run image-processing costs are not directly comparable.

| Mode | Installed SDK mean | Diagnostic SDK mean | Native interval mean | Outside native interval |
| --- | --- | --- | --- | --- |
| Image-only, 500px | 159.1ms | 158.0ms | 146.1ms | 11.8ms |
| Image-only, native size | 118.3ms | 122.2ms | 112.1ms | 10.1ms |
| UI-only | 58.4ms | 60.7ms | 55.9ms | 4.8ms |
| Full, 500px | 174.3ms | 176.8ms | 164.2ms | 12.6ms |

These are arithmetic means from this paired run, not the earlier boundary run. The diagnostic-minus-installed means ranged from -1.2ms to +4.0ms. That shows measurement/build noise and possible instrumentation cost; it does not prove zero overhead or a speedup.

For capped image-only, the native interval breaks down as follows. Each microsecond is counted once:

| Native stage or group | Mean |
| --- | --- |
| Windows `PrintWindow` | 42.0ms |
| Lanczos3 downscale | 32.1ms |
| Two process snapshots | 20.2ms |
| Rest of those two process enumerations | 5.7ms |
| Pixel readback and GDI cleanup | 7.0ms |
| PNG decode before resize | 7.0ms |
| BGRA to RGBA conversion | 6.4ms |
| Full-size PNG encode | 6.2ms |
| RGBA image-buffer copy | 4.7ms |
| DWM crop | 4.2ms |
| Rest of window capture | 3.4ms |
| SDK dispatch remainder | 2.6ms |
| Shell desktop-id query | 1.3ms |
| All other native spans and gaps | 3.2ms |
| **Total native interval** | **146.1ms** |

The largest single call is `PrintWindow`. Downscaling is the next largest stage. The two process enumerations are real recurring work, not a guess: every trace contains two snapshots and two enumeration spans. Shell COM construction is small here. No UI walk appears in image-only traces. The UI-only/full traces include an actual UI walk of about 22ms.

Image-only without resizing still pays for capture, full PNG generation and metadata. Its capture publication costs about 8.5ms versus 0.7ms for the capped image. There is no evidence that base64 or JSON is the main bottleneck.

## Accounting and remaining limits

The native timer starts before parsing the received request line and ends after normal stdout flush. It excludes waiting for the request line and serialization/writing of the diagnostic stderr report. The client waits for that report before the next call; ordinal checks prevent accidental reassignment. Stderr can arrive before the client's large stdout response finishes parsing, so its relative receipt time can be negative. It is not a negative execution cost.

`scripts/native-observe-accounting.ts` partitions the union of intervals, assigning overlaps to the shortest active span. Parent spans remain in evidence but are not added to their children. Repeated labels are accumulated. Microsecond rounding is explicit. Tests cover nested/repeated spans, partial overlap, invalid evidence, and additive summaries. The image-only native interval has just 0.11ms outside all spans; another 3.4ms remains inside the broader capture owner and 2.6ms inside SDK dispatch. Those owner remainders are not secretly assigned to a child operation.

Public SDK send took 0.08ms, parse-plus-callback took 0.38ms, and parsed-message-to-call-resolution took 0.21ms for capped image-only. Explicit result projection after the timed RPC took 0.05ms. These client sub-timers are overlapping diagnostic boundaries, not another additive partition. The 11.8ms outside the native interval still includes WSL/Windows transport and process scheduling; its separate hops are unresolved. This is fine-grained attribution of the dominant native work, **not a claim that every transport hop or Windows internals was measured**.

The [earlier adapter profile](window-observe-profile.md) includes lifetime checks and human overlay work. The 211ms production Codemode result has another boundary again. Do not subtract between those runs to invent Pi overhead. Timings vary with the app, image size and host load. No game performance or optimization result is claimed.

Two earlier public-boundary runs stopped during setup because the runner initially required literal file-path equality. Their owned cleanup passed; they do not count as passing warm evidence. The exact extended-path comparison was corrected before the passing run. No app input was replayed. No production runtime, config, pin, OS setting, game, Paint or personal browser was changed.

## Verification

Four interval-accounting tests and typecheck passed. The actual Windows diagnostic build and 80 paired warm calls passed; no whole unrelated extension test suite or reload was needed. The real Herdr viewport, pane `w3ME:p2` revision1864, showed the five-line final timing summary without clipping or raw image/per-frame payloads. The private PNG was inspected after measurement and showed only the owned local fixture. These checks do not claim instant reaction or a successful game level.