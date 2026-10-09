# Opt-in persistent WGC

This is the Windows-only retained capture path from [LPT-695](https://linear.app/alexshpunt/issue/LPT-695). Native, production-tool and TUI checks passed, and the approved implementation is merged. Initial qualification kept the installed runtime unchanged. The later explicit runtime/default-selection approval and checks are recorded below.

## Choose a window route

The selected `windows-persistent-wgc` runtime now uses retained WGC for ordinary image/full window observations, including omitted capture options. UI-only never starts pixel capture. Other runtimes keep the existing native route.

`computer_observe({window_ref, capture:{backend:"wgc", granularity:"image"}})` explicitly requests WGC. `full` also collects current UI; omitted granularity remains full. Explicit `backend:"default"` selects the old native route and permits its native detail. Display capture and temporal sequences retain their existing routing.

WGC requires an explicitly selected, hash-checked Windows candidate. Unsupported runtimes refuse before replacing valid observation authority. UI-only plus WGC is invalid: UI-only never starts pixel capture. Display capture and temporal sequences do not select this backend.

Explicit WGC failure does not retry through PrintWindow, a display or another window. A WGC observation must have the native WGC receipt and capture ID. Missing or substituted receipts withhold pixels and input authority. Successful observations retain the usual one-use input rules, Safe access and lifetime checks.

Native zoom and element crop do not support this route. They refuse rather than capture through a different backend. Read a default overview explicitly if native detail is needed. Local UI inspection and annotation stay on the collected observation.

## Ownership and mapping

CUA owns retained resources on a dedicated MTA worker for each trusted runtime session and exact window. It bounds live/stopping workers to eight, queued requests to one, each request to 1500ms and idle capture retention to five seconds. Session end, cancellation, target loss and failures stop the relevant owner. Blocking Windows/GPU calls can outlive cancellation; this is not a force-termination guarantee.

WGC pixels must match stable physical DWM frame bounds. CUA removes the existing one-pixel bitmap inset, then uses the current Bilinear/single-PNG path. Unknown extents refuse input-grounding capture. The native capture service still owns session/target binding, replacement and consumption. WGC input admission reads current native dimensions rather than recapturing with PrintWindow.

## Timing and freshness

The native `state.capture_backend` receipt reports setup/reuse and capture-stage diagnostics. Tool wall time also includes transport, identity, projection, annotation and human overlay work. These are different boundaries.

A greater presentation timestamp does not prove current or changed pixels. Signed presentation age may be negative. Paint freshness remains unverified; application witnesses and returned pixels must establish the task's actual result.

## Verification status

- Adapter regressions and deterministic real-Pi projection checks passed.
- Initial Windows build found two missing test-fixture owner initializers; fixed in source `841dad7e`.
- Windows build [37929917740](https://github.com/alexshpunt/cua/actions/runs/37929917740) passed for source `841dad7e11619bf7ecba3f98e1c20319cbeb7e52`. Its owner tests, protocol checks and release build passed.
- Initial qualification used a separate task profile, `windows-persistent-wgc`, requiring driver SHA256 `cf45f42407b06da75c20d21e45da0c68093ccc43afeeaf460a5c6a286794d20d`. It did not adopt the normal runtime; the later approved switch is recorded below.
- The separate candidate passed 27 native reads on two owned fixtures: cold/warm image and full reads, idle expiry, move/shrink/grow, covering, minimized/closed-target refusal, one capture-bound pixel hit and owner isolation. Both fixtures and their profiles were removed; the normal config stayed unchanged.
- Production tools after reload returned one default planning overview, explicit WGC image/full/image reads with warm reuse, one current WGC pixel Save click and an independent pointer/click witness. The final PNG showed revision1 and counter1. UI-only returned no inherited pixels/backend, while invalid UI+WGC and native detail refused without substitute pixels.
- The actual human viewport `w3RW:p5`, revision133 at158×57 cells, showed readable backend/freshness, witness and detail-refusal results. The owned fixture exited with source/profile cleanup; `computer_close` released the peer.
- Full verification passed 378 unit tests, typecheck and 26 real-Pi tests. Temporary loading/config and all copied candidate executables were removed; normal global startup origins and loading were verified. Independent PowerShell process checks timed out. Linux launchers were absent, but external Windows process absence is not claimed.
- Read-only native review found no blocking contract issue. Required Release metadata CI [37940393155](https://github.com/alexshpunt/cua/actions/runs/37940393155) passed for the approved native head. [Native PR20](https://github.com/alexshpunt/cua/pull/20) merged as `b28749f47494d0fb5150e9f377a46605928cc8b6`; extension head `6d375bac57034cfd4efed20a78b7450c7319e8eb` merged into develop as `f15eb3814abd0079f87267c88c0654ceaf3f2901`. The merged extension tree exactly matches the qualified review head. Runtime adoption remains a separate decision.

## Observed tool timing

The finite production smoke measured whole `computer_observe` calls, including transport, identity, projection and the human overlay:

| Read | Tool wall time | Native setup | Reused resources |
| --- | ---: | ---: | --- |
| First explicit image | 229ms | 101.25ms | No |
| Following full | 134ms | 0ms | Yes |
| Following image | 104ms | 0ms | Yes |

These three samples are not a paired speed comparison or a general latency guarantee. Some native current-marker checks needed a second successful read. No production speedup, paint-freshness guarantee or full capture certification is claimed.

See [the redacted run evidence](evidence/persistent-wgc/run.json).

## Approved default selection and runtime switch

The user later explicitly requested the runtime switch and approved WGC by default for ordinary image/full observations. Only selecting the pinned `windows-persistent-wgc` profile changes omitted window backend to WGC. Old profiles, UI-only, displays and temporal sequences keep their existing routing. Explicit `backend:"default"` remains the old native path; there is no automatic fallback on WGC failure.

The exact source841dad7e artifact is copied into a separate permanent directory with all three checked executables, licenses/notices and source/hash/version metadata. The prior direct-process runtime remains intact. Its config is saved as `previous-computer-use.json` beside the new runtime for rollback. The interop setting stays unchanged.

The default-selection regression was red before the small adapter change. The changed tree passed381 unit tests, typecheck and26 real-Pi tests. A fresh task-session production run verified implicit full/image WGC receipts, warm reuse, one witnessed Save pixel click, UI-only without pixels/backend and explicit old-route capture. Its actual TUI was readable, and the owned fixture/profile/peer were cleaned.

The approved change merged into develop as `d645477df8aa0fa4266f52a82ea277e49d6a69c4` and was pushed. The normal main config now selects the permanent WGC runtime. After reload, a fresh owned fixture returned default full/image WGC receipts, UI-only without pixels/backend and explicit old-route capture. Its500×358 PNGs and actual TUI were readable. The fixture exited with source/profile cleanup, and the peer closed. See [the separate adoption evidence](evidence/persistent-wgc/adoption.json). Roll back by restoring the saved previous config into the checkout's ignored `.pi/computer-use.json`, then reload Pi; do not overwrite or delete either runtime directory.
