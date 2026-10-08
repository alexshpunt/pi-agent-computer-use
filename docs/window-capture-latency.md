# Window observation latency experiment

LPT-673 covers two costs separately: looking up the name of an already known Windows PID, and obtaining the target window's pixels. This branch is an experiment. It does not change the installed runtime.

## Process lookup

The baseline gets a process-table snapshot for `app_name`, then another for Chromium coverage metadata. The candidate queries the known PID with `QueryFullProcessImageNameW`, closes its limited-information handle, and reuses the optional basename. Exact PID/HWND ownership and lifetime checks remain separate. An unreadable name stays absent; there is no identity cache.

Two Windows owner tests check the current executable's basename and the absence of a fabricated name for PID 0. The first checkpoint failed compilation because the helper was missing. Implementation `db93a1db5935deca52f119d0acd9c2e265623a4c` passed Windows build37824130410, including both new lookup tests, owner tests and protocol/schema checks. Native latency and desktop evidence are still pending.

## Capture comparison

Keep Bilinear resize, final PNG encoding and the observation API unchanged. Compare four isolated timing builds:

- Qualified baseline with its existing guarded capture route.
- Direct process lookup with that same capture route.
- Direct lookup with forced existing WGC, including its 50ms polling interval.
- The same read-only WGC experiment with a 5ms polling interval.

Forced WGC is diagnostic only. It does not fall back to a desktop region or invent frame geometry. Its pixels do not qualify window-local input mapping. No diagnostic executable can become the production runtime.

Native timers distinguish device/item setup, pool/session setup, first-frame wait, staging allocation, GPU copy/map, row copying and cleanup. Parent timings are not added to their children. Cold setup samples stay separate from paired warm samples.

The disposable fixture changes a large colored canvas between rounds. Each returned image must contain the newly acknowledged color. The acknowledgement proves a JavaScript drawing call, not a compositor timestamp; image verification is a separate check. This does not establish maximum frame age for arbitrary applications.

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

This supporting experiment is not the canonical CUA desktop matrix. Any proposed production capture change still needs geometry, refusal, isolation, cleanup and applicable regression evidence at its exact source. Report a slower or incorrect route as a rejected alternative, rather than weakening the contract to adopt it.
