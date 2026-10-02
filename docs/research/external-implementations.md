# Context research: external computer-use implementations

## Question

What do the supplied implementations expose to a Pi agent, how do their execution and state contracts work, and what evidence exists for Windows-host control from WSL?

## Findings

### This is a source comparison, not a runtime qualification

Sources and public npm metadata were inspected on 2026-10-02. No extension was installed, no dependency or postinstall script ran, and no browser or desktop action was executed. Most references were shallow Git checkouts; DoomPi was a versioned npm tarball downloaded with scripts disabled.

The primary references received a deeper source review. The other references were inspected only for the specific comparisons below. Platform reliability, sandbox robustness, model performance, and advertised benchmarks are not established by this pass. Pi Agent IDE's own provider surface and a first migration are still separate research work.

| Reference | Inspected source | Version in inspected package | npm metadata observation |
| --- | --- | --- | --- |
| injaneity | `4b8dbd7eaa13328ab1a8a4b55d0be0b077de7d62` | 0.5.1 | Public latest: 0.5.1 |
| amaster monorepo | `b1fc6d2eb9a17171cc8fd0aebfa6b74f14f6c794` | 0.1.2-beta.15 | Public latest: 0.1.22; equivalence to this source was not checked |
| husain | `848f141ce4baf2ffd534eb86636b3946a28131fc` | 0.1.0 | Public registry returned E404 for the named package |
| edward40 | `1c56ea3f8fa7a274ad847bb3816e4f6d5454ae50` | 0.1.1 | Public latest: 0.1.1; registry gitHead differs from inspected HEAD |
| DoomPi | npm tarball, SHA-1 `f427d3f2f5bf0c4d8ac00934761432c2e27fc43e` | 0.0.1-alpha.51 | Exact published artifact inspected |
| pi-browser | `32b5baaf7ca0d6258b1d0841cff9c6c88aafff2b` | 0.1.0 | Exact repository identity resolved from source |
| pi-browser-use | `3694edf668ac66deba80fe7744039de9bb2fdc1b` | 0.12.8 | Public latest: 0.12.8 |
| pi-agent-browser-native | `708dd8ce7ae23971578ad74a418cb4c4319cf2b3` | 0.9.1 | Public latest: 0.9.1 |

**Evidence:** The pinned package manifests linked below; `git rev-parse HEAD` on each checkout; `npm view <package> version gitHead --json`; `npm pack @agimon-ai/doompi-computer-use@0.0.1-alpha.51 --ignore-scripts`. Matching version numbers alone do not prove that a source checkout matches a published artifact.

### The agent interfaces are different from the native backend choices

| Implementation | Agent-facing interface | Runtime boundary | State and observation |
| --- | --- | --- | --- |
| injaneity | 11 tools: root discovery, observation, cached queries, actions, text/waits, browser operations | TypeScript bridge plus native OS helpers; direct CDP for browser pages | Root ref + immutable stateId + element refs; compact outlines and successor diffs |
| amaster | Prefixed Cua Driver tools; 14 core tools and a group-activation tool | Stdio MCP proxy plus session-owned Rust driver daemon | Window state, screenshots, snapshot-bound element tokens; native contracts are forwarded |
| husain | One `exec_py` tool | Persistent Python child with synchronous Playwright and optional PyAutoGUI globals | Live browser objects and persistent variables; observation and checks are written by the agent |
| edward40 | One `computer` tool accepting a structured action | Same-process native Cua SDK | Fresh desktop screenshot after a supported action; no public snapshot ID |
| DoomPi | `computer_state`, `computer_action`, `computer_exec` | Session broker, Desktop host grant, and a separate script worker | Authorized window, snapshotId, elementRef, target/grant generations |

Small tool counts do not imply small implementations. Likewise, Cua Driver behind MCP and Cua Driver through a native SDK are different deployment boundaries, even when both use Cua technology. Code orchestration and semantic grounding are not mutually exclusive: DoomPi combines both.

**Evidence:** [injaneity tool contract](https://github.com/injaneity/pi-computer-use/blob/4b8dbd7eaa13328ab1a8a4b55d0be0b077de7d62/src/contract.ts#L92-L104); [amaster registration](https://github.com/TGYD-helige/pi/blob/b1fc6d2eb9a17171cc8fd0aebfa6b74f14f6c794/packages/pi-computer-use/src/index.ts#L362-L438), [tool groups](https://github.com/TGYD-helige/pi/blob/b1fc6d2eb9a17171cc8fd0aebfa6b74f14f6c794/packages/pi-computer-use/src/tool-groups.ts); [husain tool](https://github.com/husain-zaidi/pi-computer-use/blob/848f141ce4baf2ffd534eb86636b3946a28131fc/extensions/index.ts#L26-L51); [edward tool](https://github.com/SASUKE40/pi-computer-use/blob/1c56ea3f8fa7a274ad847bb3816e4f6d5454ae50/src/index.ts#L16-L34); [DoomPi types](https://cdn.jsdelivr.net/npm/@agimon-ai/doompi-computer-use@0.0.1-alpha.51/src/types/computerUse.ts).

### injaneity separates stored observation, scheduling, and delivery

The public loop is `find_roots → observe_ui → search/expand/inspect → act_ui`. Desktop windows and CDP pages share the root/state abstraction. Queries normally operate on the complete cached tree rather than capturing the UI again. A saved observation carries the physical resource key and its epoch; request-local state is restored through AsyncLocalStorage.

The TypeScript state store holds up to 128 observations. Live work is serialized per desktop PID or CDP target. Before a write dispatches, its base epoch is checked and the epoch advances. This also invalidates the old state if execution later throws after a partial effect. It guards against competing writes through this scheduler; it is not proof that a human or application has made no external change.

Actions have semantic and coordinate paths. Windows source uses UIA element identity and patterns, with foreground/pointer fallback when policy permits. Explicit `expect` conditions can check text, role, value, or absence. Results distinguish `worked`, `didnt`, and `unknown`, and distinguish a newly verified condition from one already present before dispatch.

There are important qualifications:

- A public action list is not an atomic rollback transaction. Strict-headless mode can send a native batch; fallback-capable desktop execution dispatches actions separately under the resource lane. Earlier side effects remain.
- The fallback-capable loop stops on `didnt`, but its code does not stop merely because a step is `unknown`. Aggregation preserves the unknown outcome.
- Not every `worked` result proves the application-level task succeeded. For example, the Windows helper reports successful UIA Invoke delivery as worked. A specific postcondition provides stronger evidence.
- Foreground keyboard retry is allowed only for a checked `didnt` result, not unknown. Coordinates are grounded in image-bearing state.
- Full states remain stored while compact successor diffs are shown to the agent. A full view is used when matching/diff confidence is insufficient.

This reference contains an agent-state model, not just OS input wrappers. It also carries substantial native implementation work: AX on macOS, UIA on Windows, and AT-SPI2 with optional X11 capture/input on Linux. Its architecture documentation explicitly says the Linux Wayland path is diagnostic only, not an implemented portal capture/input path.

**Evidence:** [state ownership](https://github.com/injaneity/pi-computer-use/blob/4b8dbd7eaa13328ab1a8a4b55d0be0b077de7d62/src/state.ts#L65-L119); [epoch scheduler](https://github.com/injaneity/pi-computer-use/blob/4b8dbd7eaa13328ab1a8a4b55d0be0b077de7d62/src/runtime.ts#L61-L94); [resource locks and browser successor](https://github.com/injaneity/pi-computer-use/blob/4b8dbd7eaa13328ab1a8a4b55d0be0b077de7d62/src/bridge.ts#L1363-L1395); [desktop batch path](https://github.com/injaneity/pi-computer-use/blob/4b8dbd7eaa13328ab1a8a4b55d0be0b077de7d62/src/bridge.ts#L1791-L1832); [postconditions](https://github.com/injaneity/pi-computer-use/blob/4b8dbd7eaa13328ab1a8a4b55d0be0b077de7d62/src/bridge.ts#L1930-L1983); [retry rules](https://github.com/injaneity/pi-computer-use/blob/4b8dbd7eaa13328ab1a8a4b55d0be0b077de7d62/src/actions.ts#L112-L129); [Windows UIA delivery](https://github.com/injaneity/pi-computer-use/blob/4b8dbd7eaa13328ab1a8a4b55d0be0b077de7d62/native/windows/bridge-rs/src/main.rs#L914-L1023); [platform design and Linux limits](https://github.com/injaneity/pi-computer-use/blob/4b8dbd7eaa13328ab1a8a4b55d0be0b077de7d62/docs/architecture.md#L125-L143).

### amaster is a broad driver adapter, not a second desktop engine

The source pins bundled Cua Driver Rust 0.28.2 and chooses an optional platform runtime package. The client starts a driver daemon and connects a stdio MCP proxy to it using a per-client Unix socket or Windows named pipe. Lifecycle, reconnect, cancellation, and daemon cleanup are explicit wrapper responsibilities.

The checked-in manifest contains 56 driver tools and was generated from the macOS runtime. macOS registers that manifest; other platforms discover the live tool contract at startup. Therefore, “56 tools on every platform” is not established by counting the static file.

The core profile exposes 14 driver tools. Browser, recording, sessions, cursor, window, clipboard, and diagnostics groups can be activated through `computer_use_tools`. All registered tool schemas need not be active in the model context at once. Optional screenshot analysis calls a separately configured vision model.

The generated contract offers combined accessibility/screenshot observation, query projection, traversal limits, capture-only or tree-only options, and a separate `verify_state` tool. The wrapper also truncates text and structured details. That truncation is not an immutable continuation resource like injaneity's stored output.

Element tokens have native source backing. At the upstream 0.28.2 release commit `fc188250b4ca8549b8e61f937fdb1fb560770e86`, a token combines a snapshot handle and element index. Parsing rejects bare indices without a snapshot; resolution checks PID, window conflicts, runtime generation, and cache presence. Publishing a new snapshot replaces the previous snapshot for that window; the cache keeps at most eight window snapshots per PID. This is not the same lifetime contract as injaneity's 128 saved observations.

Default wrapper checks include app-launch approval, listed high-risk tool approvals, and recording-output path validation. These are tool-level checks, not a claim that every sensitive click or text submission is detected.

**Evidence:** [driver pin](https://github.com/TGYD-helige/pi/blob/b1fc6d2eb9a17171cc8fd0aebfa6b74f14f6c794/packages/pi-computer-use/driver-release.json); [runtime selection](https://github.com/TGYD-helige/pi/blob/b1fc6d2eb9a17171cc8fd0aebfa6b74f14f6c794/packages/pi-computer-use/src/mcp-client.ts#L91-L179); [daemon and MCP boundary](https://github.com/TGYD-helige/pi/blob/b1fc6d2eb9a17171cc8fd0aebfa6b74f14f6c794/packages/pi-computer-use/src/mcp-client.ts#L296-L471); [platform registration](https://github.com/TGYD-helige/pi/blob/b1fc6d2eb9a17171cc8fd0aebfa6b74f14f6c794/packages/pi-computer-use/src/index.ts#L623-L675); [core and groups](https://github.com/TGYD-helige/pi/blob/b1fc6d2eb9a17171cc8fd0aebfa6b74f14f6c794/packages/pi-computer-use/src/tool-groups.ts); [observation and verification schemas](https://github.com/TGYD-helige/pi/blob/b1fc6d2eb9a17171cc8fd0aebfa6b74f14f6c794/packages/pi-computer-use/src/generated/cua-driver-tools.ts#L284-L691); [approval checks](https://github.com/TGYD-helige/pi/blob/b1fc6d2eb9a17171cc8fd0aebfa6b74f14f6c794/packages/pi-computer-use/src/index.ts#L156-L209); [output bounding](https://github.com/TGYD-helige/pi/blob/b1fc6d2eb9a17171cc8fd0aebfa6b74f14f6c794/packages/pi-computer-use/src/tool-result.ts); [native token parsing](https://github.com/trycua/cua/blob/fc188250b4ca8549b8e61f937fdb1fb560770e86/libs/cua-driver/rust/crates/cua-driver-core/src/element_token.rs#L63-L137); [native cache lifetime](https://github.com/trycua/cua/blob/fc188250b4ca8549b8e61f937fdb1fb560770e86/libs/cua-driver/rust/crates/cua-driver-core/src/element_cache.rs#L21-L127).

### husain moves orchestration into the agent's Python program

`exec_py({ code, timeout_ms })` executes unrestricted synchronous Python in one persistent namespace. The worker exposes a dedicated headed Chromium through Playwright. Desktop mode preloads PyAutoGUI and a Windows focus helper. The model can inspect, loop, act, wait, check values, and return images within one call.

The parent serializes calls and enforces a deadline covering lazy startup. Ordinary Python errors preserve globals and any prior side effects. Timeout, cancellation, or a PyAutoGUI failsafe stops the worker; the user must reset before continuing. Reset discards worker state, not desktop side effects. The Chromium profile persists on disk even though Python variables do not survive a new worker.

The browser/desktop mode distinction is convenience, not authority: unrestricted Python can import modules and access files, networking, and subprocesses with user permissions. The focus helper checks a uniquely identified Windows browser window at call time, not throughout the following program. There is no enforced public observation/epoch contract preventing a program from using old coordinates.

Documentation and source disagree in places:

- README says the first call asks for consent; extension source explicitly removed that prompt.
- The README comparison says injaneity needs an extra OpenAI key/client. That is not supported by the inspected injaneity extension and manifest, which register Pi tools and OS/CDP backends without such a client.
- The reported 2-versus-13 calls and 19.89-versus-64.93 seconds remain self-reported. This pass did not reproduce them, establish baseline revisions, or normalize model/environment/task conditions.
- The public npm name returned E404 during this pass despite npm installation instructions in the README. GitHub source was available.

The reduced roundtrip opportunity is real at the interface level. Its measured advantage over a comparable semantic/batched interface is not established here.

**Evidence:** [tool and removed consent](https://github.com/husain-zaidi/pi-computer-use/blob/848f141ce4baf2ffd534eb86636b3946a28131fc/extensions/index.ts#L26-L51); [serialized runtime and cancellation](https://github.com/husain-zaidi/pi-computer-use/blob/848f141ce4baf2ffd534eb86636b3946a28131fc/src/client.ts#L23-L79); [persistent browser and Python exec](https://github.com/husain-zaidi/pi-computer-use/blob/848f141ce4baf2ffd534eb86636b3946a28131fc/python/worker.py#L153-L203); [focus helper](https://github.com/husain-zaidi/pi-computer-use/blob/848f141ce4baf2ffd534eb86636b3946a28131fc/python/worker.py#L122-L151); [README claims](https://github.com/husain-zaidi/pi-computer-use/blob/848f141ce4baf2ffd534eb86636b3946a28131fc/README.md#L7-L65); [injaneity manifest](https://github.com/injaneity/pi-computer-use/blob/4b8dbd7eaa13328ab1a8a4b55d0be0b077de7d62/package.json). Public-registry E404 was observed with `npm view @husain-zaidi/pi-computer-use version gitHead --json` on the inspection date.

### The smaller references answer different questions

**edward40: a coordinate-first baseline.** The structured `computer` action surface is small. The native SDK is loaded in-process and a session is created with desktop capture scope. Calls are serialized and a fresh PNG is returned after supported actions. An action error or cancellation after dispatch produces an unknown-outcome warning and attempts a fresh recovery capture without reusing the caller's aborted signal. The agent still chooses coordinates from the latest image; there is no public snapshot/epoch argument enforcing that rule. If recovery capture itself fails, there is no guarantee of a returned image.

Its `@trycua/cua-driver` dependency is 0.18.0. That SDK version must not be confused with amaster's Rust driver binary version 0.28.2.

**Evidence:** [native dependency](https://github.com/SASUKE40/pi-computer-use/blob/1c56ea3f8fa7a274ad847bb3816e4f6d5454ae50/package.json#L47-L49); [unknown-outcome handling](https://github.com/SASUKE40/pi-computer-use/blob/1c56ea3f8fa7a274ad847bb3816e4f6d5454ae50/src/runtime.ts#L184-L223); [session and SDK calls](https://github.com/SASUKE40/pi-computer-use/blob/1c56ea3f8fa7a274ad847bb3816e4f6d5454ae50/src/runtime.ts#L225-L299); [fresh observation](https://github.com/SASUKE40/pi-computer-use/blob/1c56ea3f8fa7a274ad847bb3816e4f6d5454ae50/src/runtime.ts#L404-L428).

**DoomPi: semantic actions plus restricted code.** The inspected published artifact documents a supported packaged macOS DoomPi Desktop, not a generally available Windows/WSL desktop backend. Host-issued window grants, expiry, session ownership, and target generations are part of the architecture. Actions carry snapshotId and elementRef and are limited to press, focus, set_value, and scroll.

Its default script execution runs JavaScript/erasable TypeScript with relative helpers in QuickJS WebAssembly inside a child process. Source paths are confined to an admitted root. Program operations are brokered back to the authorized session. A separately requested trusted mode needs an exact host-configured path allowlist and runs unsandboxed Node. Each invocation has a new worker; unlike husain, script globals are not a persistent REPL.

This shows that code-mode need not expose an unrestricted OS runtime. It does not establish that the sandbox is escape-proof: no adversarial security audit or Desktop host test was performed.

**Evidence:** [Desktop requirements](https://cdn.jsdelivr.net/npm/@agimon-ai/doompi-computer-use@0.0.1-alpha.51/README.md); [state and grant types](https://cdn.jsdelivr.net/npm/@agimon-ai/doompi-computer-use@0.0.1-alpha.51/src/types/computerUse.ts); [script contract](https://cdn.jsdelivr.net/npm/@agimon-ai/doompi-computer-use@0.0.1-alpha.51/docs/computer-scripts.md); [QuickJS worker and path checks](https://cdn.jsdelivr.net/npm/@agimon-ai/doompi-computer-use@0.0.1-alpha.51/dist/extensionService-BSqhP2uB.mjs).

### Browser-only wrappers add profile and session semantics, not Windows UIA

The ambiguous browser package names were resolved to these repositories:

| Reference | Observed design | Useful distinction |
| --- | --- | --- |
| larsderidder/pi-browser | In-process Playwright session; localhost CDP attach or browser launch; separate browser tools | Action responses request a fresh page snapshot; snapshots are bounded and can be scoped with a selector |
| 0xPlayerOne/pi-browser-use | Curated tools over chrome-devtools-mcp; fresh, persistent, and existing-browser modes | Browser profile identity, focus/headless policy, output redaction, and connection lifecycle are wrapper concerns |
| fitchmultz/pi-agent-browser-native | Wrapper around external agent-browser; native args plus semantic and code orchestration surfaces | Session/page ref tracking, invalidation after transitions, and recovery are substantial parts of the wrapper |

The pi-browser source currently reads ordinary Playwright `ariaSnapshot()` and resolves a supplied ref through `locator('aria/<ref>')`. No immutable snapshot ID is checked in that path. Its README's “element ref” wording is not proof of a versioned reference model.

The browser-use configuration confirms persistent/headless defaults and explicit fresh/persistent/existing mode switching. It is a different package from `@amaster.ai/pi-browser-use`; those sources must not be mixed.

Browser-native's README records waived Windows qualification for a particular rollout and warns that it was not a Windows full-suite pass. This is support evidence with limits, not a platform reliability result from our own test.

**Evidence:** [pi-browser connection](https://github.com/larsderidder/pi-browser/blob/32b5baaf7ca0d6258b1d0841cff9c6c88aafff2b/src/browser-session.ts#L28-L76), [snapshot and ref resolution](https://github.com/larsderidder/pi-browser/blob/32b5baaf7ca0d6258b1d0841cff9c6c88aafff2b/src/tab.ts#L142-L171), [action response snapshot](https://github.com/larsderidder/pi-browser/blob/32b5baaf7ca0d6258b1d0841cff9c6c88aafff2b/src/tools/snapshot.ts#L38-L64); [browser-use package identity](https://github.com/0xPlayerOne/pi-browser-use/blob/3694edf668ac66deba80fe7744039de9bb2fdc1b/package.json), [config defaults and mode handling](https://github.com/0xPlayerOne/pi-browser-use/blob/3694edf668ac66deba80fe7744039de9bb2fdc1b/src/config.ts), [README defaults](https://github.com/0xPlayerOne/pi-browser-use/blob/3694edf668ac66deba80fe7744039de9bb2fdc1b/README.md#L8-L16), [MCP client](https://github.com/0xPlayerOne/pi-browser-use/blob/3694edf668ac66deba80fe7744039de9bb2fdc1b/src/client.ts); [browser-native state invalidation](https://github.com/fitchmultz/pi-agent-browser-native/blob/708dd8ce7ae23971578ad74a418cb4c4319cf2b3/extensions/agent-browser/lib/session-page-state.ts#L239-L279), [wrapper/support statements](https://github.com/fitchmultz/pi-agent-browser-native/blob/708dd8ce7ae23971578ad74a418cb4c4319cf2b3/README.md#L7-L99).

### WSL-to-Windows desktop control is not established

The inspected default paths select local backends by runtime platform:

- injaneity selects Linux AT-SPI2 for `process.platform === 'linux'`, not its Windows UIA helper.
- amaster chooses the Linux runtime package and Unix-socket lifecycle for a Linux Node process. A custom binary path does not by itself translate that protocol into Windows named-pipe ownership.
- husain starts a local Python worker; its verified native focus path requires Python `sys.platform == 'win32'`. An interpreter override alone does not prove Linux/Windows path, cwd, cleanup, and display bridging.
- edward loads the native SDK for the host platform. No WSL host bridge was established by this wrapper review.
- DoomPi's inspected artifact requires its macOS Desktop host.

Searches for WSL, wslpath, and Windows-mounted path handling found no matches in the reviewed primary wrappers. That is supporting evidence only, not proof that cross-host control is impossible.

Browser CDP is a different boundary: a reachable, authorized Windows browser debugging endpoint could allow browser-page control from WSL. It does not grant Windows application/window UIA control or OS dialog/input access.

A future controlled experiment would need to identify an authorized Windows test window from WSL, compare semantic state and screenshot geometry, perform one bounded text/value action and verify the result, reject an old reference after a state change, and prove cancellation releases owned work/input. Nothing in this pass executed that experiment or selected its transport.

**Evidence:** [injaneity platform dispatch](https://github.com/injaneity/pi-computer-use/blob/4b8dbd7eaa13328ab1a8a4b55d0be0b077de7d62/src/platform/index.ts#L52-L59); [amaster runtime selection](https://github.com/TGYD-helige/pi/blob/b1fc6d2eb9a17171cc8fd0aebfa6b74f14f6c794/packages/pi-computer-use/src/mcp-client.ts#L91-L179), [socket ownership](https://github.com/TGYD-helige/pi/blob/b1fc6d2eb9a17171cc8fd0aebfa6b74f14f6c794/packages/pi-computer-use/src/mcp-client.ts#L396-L471); [husain interpreter](https://github.com/husain-zaidi/pi-computer-use/blob/848f141ce4baf2ffd534eb86636b3946a28131fc/extensions/index.ts#L14-L23), [Windows-only focus guard](https://github.com/husain-zaidi/pi-computer-use/blob/848f141ce4baf2ffd534eb86636b3946a28131fc/python/worker.py#L122-L151); [edward native loader](https://github.com/SASUKE40/pi-computer-use/blob/1c56ea3f8fa7a274ad847bb3816e4f6d5454ae50/src/runtime.ts#L59-L69); [browser CDP attach](https://github.com/larsderidder/pi-browser/blob/32b5baaf7ca0d6258b1d0841cff9c6c88aafff2b/src/browser-session.ts#L35-L49); [DoomPi host requirements](https://cdn.jsdelivr.net/npm/@agimon-ai/doompi-computer-use@0.0.1-alpha.51/README.md#L5-L9).

### The reusable ideas are separable, but no architecture is selected

**Inference from the inspected contracts:** four dimensions should be compared separately:

1. Observation and identity: screenshots, semantic trees, scoped refs, stored states, and truthful limits.
2. Execution mechanics: OS helper, local native SDK, MCP daemon, CDP, or Python worker.
3. Orchestration: one action, a dependent batch, or generated code with checks and loops.
4. Authority and lifecycle: which application/session is authorized, what can run, and what happens after cancellation or uncertain delivery.

The references demonstrate different combinations. A single exec tool does not replace the need for grounded targets; semantic references do not rule out code orchestration. “Action delivered”, “state changed”, and “task postcondition met” are different levels of evidence.

None of the reviewed registrations demonstrates integration with Pi Agent IDE's existing read/insert/provider APIs. That fit still needs the IDE inventory. This report does not select a backend, language, public resource scheme, supported platform, or first migration.

**Evidence:** The state, action, orchestration, and runtime source links in the findings above.
