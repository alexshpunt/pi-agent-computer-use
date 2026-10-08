# Window observation latency experiment

LPT-673 covers two costs separately: looking up the name of an already known Windows PID, and obtaining the target window's pixels. The isolated comparison finished without changing the installed runtime. The user then explicitly approved switching to the checked direct-lookup production artifact. Capture stays on the existing guarded PrintWindow route; WGC is not adopted.

## Process lookup

The baseline gets a process-table snapshot for `app_name`, then another for Chromium coverage metadata. The candidate queries the known PID with `QueryFullProcessImageNameW`, closes its limited-information handle, and reuses the optional basename. Exact PID/HWND ownership and lifetime checks remain separate. An unreadable name stays absent; there is no identity cache.

Two Windows owner tests check the current executable's basename and the absence of a fabricated name for PID 0. The first checkpoint failed compilation because the helper was missing. Implementation `db93a1db5935deca52f119d0acd9c2e265623a4c` passed Windows build37824130410, including both new lookup tests, owner tests and protocol/schema checks. The supporting paired measurements and pixel review are recorded below; canonical desktop certification is not claimed.

## Capture comparison

Keep Bilinear resize, final PNG encoding and the observation API unchanged. Compare four isolated timing builds:

- Qualified baseline with its existing guarded capture route.
- Direct process lookup with that same capture route.
- Direct lookup with forced existing WGC, including its 50ms polling interval.
- The same read-only WGC experiment with a 5ms polling interval.

Forced WGC is diagnostic only. It does not fall back to a desktop region or invent frame geometry. Its pixels do not qualify window-local input mapping. No diagnostic executable can become the production runtime.

Native timers distinguish device/item setup, pool/session setup, first-frame wait, staging allocation, GPU copy/map, row copying and cleanup. Parent timings are not added to their children. Cold setup samples stay separate from paired warm samples.

The disposable fixture changes a large colored canvas between rounds. Each returned image must contain the newly acknowledged color. The acknowledgement proves a JavaScript drawing call, not a compositor timestamp; image verification is a separate check. This does not establish maximum frame age for arbitrary applications.

## Paired result

All four exact diagnostic Windows builds passed and their three executable hashes were checked. One disposable Chrome window supplied all samples, with alternating order between rounds. Each route passed ten changing-color image rounds. Baseline and direct lookup also passed five full and five UI-only rounds each. The run admitted 68 samples including setup; all clients, staged files, the window and its profile were cleaned up. Installed config and executable bytes stayed unchanged.

| Warm SDK receipt | Baseline | Direct PID, same capture | WGC 50ms poll | WGC 5ms poll |
| --- | ---: | ---: | ---: | ---: |
| Image-only median, 10 samples | 122.08ms | 82.03ms | 192.09ms | 170.74ms |
| Image-only mean | 126.47ms | 85.26ms | 196.43ms | 175.74ms |
| Full median, 5 samples | 125.37ms | 105.17ms | Not tested | Not tested |
| UI-only median, 5 samples | 64.33ms | 27.77ms | Not tested | Not tested |
| First image setup receipt, 1 sample | 167.94ms | 127.82ms | 352.78ms | 281.91ms |

These are supporting measurements on one machine and one window, not production tool wall time or a general speed guarantee. First setup receipts are not part of the warm statistics.

### Where image-only time went

The following are **mean exclusive native stage times** from the same ten image rounds, not independently added medians. The full exclusive maps in [the redacted evidence](evidence/window-capture-latency/run.json) add exactly to each native mean.

| Stage | Baseline | Direct PID |
| --- | ---: | ---: |
| Two process snapshots plus enumeration overhead | 36.08ms | 0ms |
| One direct process-name query | 0ms | 0.17ms |
| PrintWindow call | 45.09ms | 43.26ms |
| GDI readback and cleanup | 8.65ms | 7.35ms |
| DWM frame crop | 6.37ms | 5.94ms |
| Channel conversion | 8.29ms | 8.27ms |
| Bilinear resize | 5.06ms | 4.88ms |
| Final PNG encode | 0.27ms | 0.25ms |
| Other native work | 11.49ms | 11.11ms |
| Native total | 121.30ms | 81.22ms |
| SDK receipt minus native total | 5.17ms | 4.05ms |

The candidate replaces two process scans with one known-PID query in every admitted mode and keeps the executable basename. It does not optimize PrintWindow. The PrintWindow timer measures the call, not its Boolean result; the default route's existing fallback guards remain. This run does not separately certify every possible fallback.

WGC did not win. Its mean device/item setup was 69.90ms with 50ms polling and 74.43ms with 5ms polling. Mean first-frame wait fell from 50.37ms to 25.07ms, but pool/session setup still cost about 14ms, copy/map about 8ms, and BGRA row copying about 7ms. Those resources are recreated for every request, even in the warm group. The shorter interval is not a promise of a frame in 5ms. WGC also lacks qualified input geometry here, so it is not an adoption candidate regardless of speed.

### Pixel review and limits

Four saved fixture overviews were reviewed: the heading, marker and Save control remained understandable at a 500px cap. Browser chrome was small. Every admitted image contained at least 40 pixels of the current acknowledged marker color within RGB tolerance 3. Baseline and direct images matched the witness count in each warm pair. No timing input or foreground raise was sent.

Two earlier runs admitted no samples. The first stopped on the current-color assertion; a diagnostic rerun saved a readable Frame 1 whose expected RGB60/170/80 appeared as RGB93/168/90. The successful run forced sRGB only in the new browser's unique disposable profile, using Chromium's documented `--force-color-profile` switch. The assertion and tolerance were not weakened; neither the monitor profile nor personal Chrome was changed. A JavaScript acknowledgement is still not a compositor timestamp, and the ten-color witness is not a universal stale-frame detector.

**Recommendation:** qualify direct PID lookup for a later adoption decision, retain the current capture route, and reject these per-call WGC variants as latency replacements. Reusing native capture resources would be a separate experiment with its own freshness, lifetime and geometry checks. The later explicit adoption decision is recorded below; the comparison itself did not select a runtime.

This speed comparison alone was not a complete adoption qualification. The targeted follow-up below adds metadata, ownership and closed-target checks for direct PID lookup. No capture route or geometry changed; a proposed capture replacement would still need the applicable covered/moved/resized/minimized and coordinate-click matrix.

## Direct lookup follow-up checks

The user approved targeted checks after reviewing the comparison. `verify-direct-process-lookup.mjs` first passed on production db93a1db, then repeated the same checks on the final production artifact33e264ffe6310151450020945d2398072c446c49. Each run used a separately staged bundle, not a trace build or the installed runtime, and made 11 candidate requests on a new disposable Chrome window:

- Image-only, UI-only and full observations kept both the executable basename and complete browser capture-coverage metadata equal to the retained runtime.
- An intentionally wrong PID was refused in all three modes with the exact ownership error, without pixels or fabricated application metadata.
- A correct observation still worked after each refused request.
- After the owned window was closed and its profile removed, image-only and UI-only requests using the old target were refused as missing, without pixels or application metadata.

The current-color witness passed; the saved overview was reviewed. No fixture-content input was sent. All owned resources were cleaned up and installed config/bytes stayed unchanged. See [the bounded live evidence](evidence/window-capture-latency/lookup.json). Closing a window is not a controlled reproduction of a process exiting precisely between two native API calls, and no actual PID reuse was forced.

A first permission test incorrectly assumed that querying Windows System PID4 must fail. The CI host allowed it; build37838369449 failed on that test assumption, not on the candidate's normal lookup behavior. The replacement reads through a real handle to the test process with synchronization rights only. It changes no DACL or token privileges and checks the native image-query access-denied error. Candidate33e264ff extracts the borrowed-handle query as a normal internal function; the public lookup still closes its handle and maps either native error to an absent name. Exact Windows build37839341392 passed68contract,839core and298Windows owner tests (one pre-existing ignored), including the real-handle permission check, plus2protocol and4schema tests. All three executable hashes matched; final driver SHA256a3219d246f3b951965c07a13b0ffd0509ab2f66861f0087fd337d7e3084de674 passed the repeated11request live check. The direct lookup's native errors remain best-effort absent metadata, not proof that a process is alive. These checks ran before the user's later runtime-switch approval.

## Approved runtime selection

The user explicitly requested the runtime switch after the final lookup checks. Trusted profile `windows-direct-process` pins source `33e264ffe6310151450020945d2398072c446c49`, version0.34.0 and driver SHA256 `a3219d246f3b951965c07a13b0ffd0509ab2f66861f0087fd337d7e3084de674`. All three verified production executables and their license/notices are copied to a separate source-specific directory; no trace build is selected. Capability checks preserve Bilinear and the earlier input/display routes. Changed driver bytes refuse before startup.

The previous `windows-fast-bilinear` directory and trusted config are retained for rollback. Bundled package defaults stay unchanged. Native PR17 merged at `19761b651c73f6fe53f6a21d13e3e5cb1963ee90`; the selected bytes remain the tested33e264ff artifact, not a rebuilt merge artifact. After the approved reload, the main checkout selected these exact bytes. Production full, image-only and UI-only observations passed. A current image-only pixel Save click and a fresh UI-only hinted Save click were delivered and independently witnessed by two application clicks, two pointer events and counter2. Image-only carried no UI; UI-only carried no pixels; native image metadata reported Bilinear. The actual Pi viewport showed readable mode and delivery results (pane w3MD:pN, revision11). The owned fixture/profile and runtime were released, leaving user windows untouched. Integrated verification passed369unit tests, typecheck and25real-Pi tests. The combined terminal's final Git diff check was refused after reload because its managed session credential was unavailable; a fresh managed diff check passed separately. See [adoption evidence](evidence/window-capture-latency/adoption.json). This change does not claim a faster PrintWindow call, WGC adoption or new capture-geometry certification.

Rollback: restore the saved `previous-computer-use.json` from the new source-specific directory to the checkout's ignored `.pi/computer-use.json`, then reload Pi. Do not overwrite either runtime directory.

## Reproduce

Use exact source commits and ignored output directories:

```sh
node scripts/prepare-native-window-capture-comparison.mjs NATIVE_REPO SHA .tmp/window-capture-latency/generated-default default
node scripts/prepare-native-window-capture-comparison.mjs NATIVE_REPO SHA .tmp/window-capture-latency/generated-wgc wgc
node scripts/prepare-native-window-capture-comparison.mjs NATIVE_REPO SHA .tmp/window-capture-latency/generated-wgc5 wgc-poll5
```

`commit-native-diagnostic.mjs` creates separate `diagnostic/*` child commits without touching the native checkout or its normal index. The Windows fork workflow accepts an exact SHA and builds the three runtime executables. It uses a shared concurrency group: dispatch diagnostic builds sequentially, because a later pending run can cancel an earlier pending run.

Prepare a private JSON plan containing `config`, `installed_sha256`, optional live `interop`, and `variants` entries named `baseline`, `direct`, `wgc`, `wgcPoll5`. Each entry needs its diagnostic `source`, extracted artifact `directory`, and driver `sha256`. Artifacts must be under `.tmp/window-capture-latency/` and keep their `source-sha.txt`, `hashes.json` and `runtime/` files.

```sh
node --experimental-transform-types scripts/qualify-native-window-capture.mjs .tmp/window-capture-latency/plan.json --owned-fixture
```

For already dispatched builds, `run-native-window-capture-comparison.mjs` can finish the same work serially. Its private input replaces `variants` with `runs`, where each role has an exact `source` and GitHub run `id`. It allows one rerun for a cancelled queue entry, stops on source failures, verifies all downloaded executable hashes, and then invokes the supporting runner once. Each build wait is limited to 70 minutes and the fixture runner to 10 minutes.

Build status checks use short calls through the installed managed `gh` wrapper. A single long `gh run watch` can outlive its supplied credential; one watch stopped on HTTP 401 during this experiment while the build continued. The runner resumes read-only monitoring of the same run, not the build itself. Private command errors are saved to a local log instead of flooding tool output.

```sh
node scripts/run-native-window-capture-comparison.mjs .tmp/window-capture-latency/build-plan.json --owned-fixture
```

The supporting runner stages separate verified bytes, opens one new private Chrome fixture through CUA, performs only read-only timing probes, and then cleans up its fixture, profile and clients. It verifies that installed bytes and config are unchanged. It never captures a display or sends timing input. Private pixels and errors stay in the ignored run directory; only bounded summaries are printed.

For the narrower direct-lookup checks, prepare a private plan with `config`, `installed_sha256`, `interop`, and `candidate:{source,directory,sha256}` for the exact production artifact. The runner verifies all three executable hashes before opening one disposable window:

```sh
node --experimental-transform-types scripts/verify-direct-process-lookup.mjs .tmp/window-capture-latency/lookup-plan.json --owned-fixture
```

It compares metadata in each observation mode, checks exact wrong-PID and closed-target refusals, and verifies cleanup without switching the installed runtime.

This supporting experiment is not the canonical CUA desktop matrix. Any proposed production capture change still needs geometry, refusal, isolation, cleanup and applicable regression evidence at its exact source. Report a slower or incorrect route as a rejected alternative, rather than weakening the contract to adopt it.
