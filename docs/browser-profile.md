# Browser operation profiler

See [the measured results and slow-path breakdown](browser-profile-results.md).

Run a separate, opt-in timing pass from the repository root:

```sh
node --experimental-transform-types scripts/profile-browser.mjs 5
```

Use Node with TypeScript transform support and the already qualified Windows CUA 0.33.2 runtime. No installation, runtime upgrade or persistent setting change is performed. The optional count is 1..20, default 5.

The runner opens **one new isolated synthetic browser**. It does not use, reset or close the browser owned by your Pi session, including a paused game. Normal automatic foreground can take keyboard focus. Native cursor and installed Qt window frames remain enabled. Do not run overlapping native profiling passes: an unrelated process/profile appearing during cleanup makes that check uncertain rather than a pass.

## What runs

One cold open, repeated warmed operations, then one close:

- tabs and focus;
- full overview, image-only overview and native zoom;
- hint click without capture, with image-only capture and with renewed semantics;
- fill, hover and scroll;
- window-image and zoom-image point clicks;
- navigation without capture and with renewed semantics.

Each distribution states its actual sample count. Open and close have one sample per pass, not five. Extra observations needed to ground input are marked `setup`, not mixed with warmed distributions. Synthetic server-side counters verify click, input, hover, scroll and navigation effects outside the timer. Native image, foreground and frame acknowledgements are checked too; these do not prove paint readiness.

## Timing boundary

The timer wraps the retained `CuaBrowser.call` adapter. Production `browser_*` registration is temporarily disabled; this standalone runner still calls the adapter directly. The runner decorates its normal `McpDriver` and window observer, without changing the adapter or removing checks. It records ordered native RPC, window lifetime, transport-close and frame-flash timings. Binding and semantic `get_browser_state` calls have different labels.

**A native RPC duration includes IPC, transport and Driver processing.** The first RPC also includes lazy process startup and MCP handshake. It does not measure time inside the Driver's capture function separately. First identity/frame use includes lazy peer/helper startup. A child's `cold` flag means first invocation of that label, not proof that every millisecond was startup.

Root totals exclude fixture verification, file writes and console output. Child intervals are unioned, so overlapping/nested work is counted once. `remaining_ms` is total minus covered child time: adapter/JavaScript scheduling and instrumentation outside those children, not a separate native measurement.

This runner does **not** measure Pi tool registration, Codemode delivery, model latency, provider upload or TUI rendering. A 1.8-second Pi tool row and this adapter timer are different boundaries.

## Output and failure

Console rows show total time, child count and remaining time. The final table gives min/p50/p95/max in JSON and p50/p95 in the console. With five samples, p95 is the largest sample; this is a small diagnostic series, not a general performance guarantee. The first successful warmed zoom is also expanded into ordered child rows.

The report is `.tmp/browser-profile/run-<time>/report.json`. It stores fixed operation labels, timings, outcomes and cleanup booleans only: no arguments, screenshots, text, entered values, URLs, window IDs or ownership markers. A separate ignored synthetic overview PNG is saved only to inspect pixel grounding; it is not part of the report.

Refused, unknown, thrown or unverified operations stop the pass without input replay. Partial reports retain failed samples but exclude them from successful distributions. Cleanup attempts the run's browser/session, helper and fixture even after failure; a read-only Windows check confirms owned PIDs exited, no new Driver/profile remains and pre-existing profiles remain. It does not kill unrelated processes. Any uncertain cleanup fails the pass. SIGINT/SIGTERM cancel the measured call and take the same cleanup path.
