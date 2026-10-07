# Window observation profiling

Run a separate diagnostic pass from the repository root:

```sh
WSL_INTEROP=/run/WSL/364_interop node --experimental-transform-types scripts/profile-window-observe.mjs 10
```

Use the current live interop endpoint and existing qualified runtime, not the example endpoint if it is no longer valid. Sample count is1..20, default10. No installation or persistent setting change is made.

The runner opens one new isolated local browser fixture. It performs read-only full/image/UI observations and confirms that no fixture events occurred during samples. Cleanup closes only the owned browser/profile, session, helper and local site. It does not read or operate the game, Paint or personal browser data.

## Timing boundary

The root wraps the real registered `computer_observe.execute` method and its normal ComputerSession. Decorators measure ordered native MCP calls, all window identity checks and normal human-overlay acknowledgements. Nothing is bypassed or disabled.

Native RPC includes Windows processing and transport. It does not isolate capture, image encoding or IPC inside the Driver. The root excludes Pi hooks, Codemode transport, model/provider work and TUI rendering. First-use labels do not imply that all cold time is process startup. Fixture launch, verification, report writes and cleanup are outside observation totals.

Child intervals are unioned. Remaining time is root minus covered children: image metadata/annotation, UI projection, JavaScript scheduling and uninstrumented adapter work. It is not a separate native measurement.

Raw samples contain only fixed labels, timings and outcomes. No arguments, URLs, native IDs, tokens or screenshots are copied into the tracked report. A private owned overview is saved only for visual grounding.

## Observed result

[Redacted report](evidence/window-observe-profile/run.json): unchanged windows-shell-desktops runtime,500px cap,scale1,466×500 PNGs, hints/guides off, ordinary human frame enabled. Ten warm samples per mode alternate order. All30 observations and owned cleanup passed.

Means give an additive breakdown; medians of individual components do not necessarily add to the root median.

| Mode | Whole call mean | Native RPC | Three identity checks | Overlay | Adapter remainder |
| --- | --- | --- | --- | --- | --- |
| full | 190.4ms | 159.8ms | 10.4ms | 16.4ms | 3.9ms |
| image | 147.1ms | 123.7ms | 6.5ms | 15.1ms | 1.9ms |
| ui | 113.3ms | 86.2ms | 7.8ms | 17.2ms | 2.1ms |

Whole-call medians were178.2ms full,153.0ms image and109.8ms UI. These are a new run at a different timing boundary from the earlier [211ms production Codemode result](observation-granularity-results.md). Do not subtract them to claim measured Pi overhead.

About84% of the mean image-only call was native RPC. Identity checks were not the main bottleneck; overlay cost about10%. Removing all adapter remainder would save only about2ms in this run. The next diagnostic boundary is inside native capture/encoding/transport, not blind removal of lifetime checks. These measurements do not authorize a runtime change or promise instant reaction.

The later [native timing profile](native-observe-profile.md) measures internal Windows stages on a separate diagnostic build. It identifies PrintWindow, Lanczos3 and two process enumerations as the largest native costs, with explicit transport and owner remainders.

Syntax checking and the out-of-bound sample-count guard passed. No production extension code was changed, so no extension reload or whole unrelated test suite was needed.
The live Herdr viewport (pane w3ME:p2, revision1574) showed the compact final timing summary on one readable line. No screenshots or per-frame payloads were printed by the measurement loop.