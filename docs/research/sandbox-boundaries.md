# Sandbox boundaries for computer use

## Result

Research for [LPT-364](https://linear.app/alexshpunt/issue/LPT-364), inspected on 2026-10-02. No sandbox, guest app or Driver was started. No Windows/WSL settings, services, firewall rules or permissions were changed. This task did not change Pi Agent IDE or the working host extension.

**Recommendation:** qualify Windows Sandbox first for disposable native Windows work. Use a normal Windows VM when installed apps, saved state or parallel sessions matter. A private Linux desktop in WSL is useful for Linux apps, but a separate display or distribution alone is not the security boundary we need.

The next experiment should first prove guest Driver observation/input and host non-interference offline. A live Pi-to-guest bridge is a separate, explicit gate, not an existing capability. Nothing in this report authorizes that experiment or its setup.

This is a source-backed feasibility comparison, not a security audit or a live isolation pass. Microsoft documentation describes the platform boundaries; pinned Cua source describes available mechanisms. Proposed topologies and restrictions below are recommendations. Local metadata establishes only the facts in [sandbox-local-facts.json](sandbox-local-facts.json).

## Three routes

| Question | Windows Sandbox | Normal Hyper-V Windows VM | Private Linux desktop in WSL 2 |
| --- | --- | --- | --- |
| Boundary | Guest Windows kernel behind the Microsoft hypervisor, with explicit host redirection channels [1, 2] | Separate guest OS; disk, devices, integration and network need an explicit policy [4, 5] | WSL VM separates Linux from Windows, but distributions share its kernel/network/devices. Add a restricted workload boundary, not just another display [7–10] |
| Apps | Guest-installed native Windows apps. Host apps are absent. Newer Sandbox builds lack inbox Notepad, Calculator and Store [1, 3] | Guest-installed Windows apps and their dependencies; host apps are still not inherited | Native Linux apps. This does not provide native Windows app compatibility |
| State | Closing destroys guest state; an internal reboot can preserve it on supported builds. Writable host mappings survive disposal [1, 2] | Persistent guest disk; explicit checkpoint/revert or disposable image workflow | Distribution filesystem persists; a disposable workload root must be designed and removed separately |
| Parallelism | One Sandbox at a time. Apps inside it share one user/desktop [1, 3] | Multiple separately configured VMs, within host resource limits [4] | Multiple private displays/workloads are possible; they still share the WSL kernel unless given a different VM |
| Setup | Supported Pro/Enterprise/Education edition, not Home; virtualization and enabled Sandbox feature/client [1, 3] | Hyper-V role, image, guest licensing/credentials, virtual disks and switches [4, 6] | Linux GUI packages, display server, toolkit/AT-SPI, restricted workload root and privileges; version-specific Driver qualification [10–13] |
| Resource/startup cost | Microsoft describes a launch of a few seconds. Minimum 4 GB host RAM, 1 GB free disk, 2 cores; default guest memory cap 4 GB. App/bootstrap work adds cost [1–3] | More initial setup/storage and boot cost. Budget RAM/CPU for host plus every guest; exact local cost unmeasured [3, 4] | Xvfb uses an in-memory framebuffer; GUI/runtime packages and each workload add cost. No local startup or memory benchmark was run [11] |
| Driver location | Inside the guest's interactive user session | Inside the guest's interactive user session | Inside the private display **and** private accessibility bus, using the Linux binary |
| Pi connectivity | Guest-local Pi/client over stdio, or a new trusted bridge from WSL. `wsb exec` is not an MCP stdio tunnel [14] | Guest-local Pi/client, or an authenticated tunnel to a guest-local broker; interactive-session placement still required | A guest-local client over stdio, or a trusted supervisor relaying stdio across the restricted workload boundary |

The minimum requirements are not a capacity plan for a model, browser or many apps. Driver latency, cold provisioning, shutdown and concurrent resource costs remain unmeasured in all proposed guests.

## Windows Sandbox: a real boundary with unsafe defaults for this use

Microsoft documents a separate Windows kernel and temporary filesystem. That is materially stronger than window ownership on the host. It is not permission to leave every host channel open. [1, 2]

For a first offline qualification, propose these settings explicitly:

- Networking off. The default is on through the Hyper-V default switch, which can reach the internal network.
- Clipboard redirection off. The default shares text and files both ways.
- Audio input off; video input and printer redirection off. Audio input is on by default.
- No personal folders, repositories, credentials or full host drives mapped into the guest.
- One read-only bootstrap directory containing only reviewed, pinned test payloads. Read-only prevents guest writes, not disclosure of its contents.
- If evidence must leave an offline guest, one new, empty writable outbox only. This is an intentional host-write channel, not an isolated filesystem. The host must treat returned files as untrusted data: bounded JSON/PNG, no auto-execution, no following links/reparse points, no overwriting unrelated paths.
- Consider Protected Client and disabling vGPU for the first trial. Protected Client adds AppContainer protections to the client path; it is not a replacement for the guest boundary. vGPU adds attack surface; software rendering may change performance and capture behavior. These combinations need qualification, not a compatibility promise.

Mapped folders are available before the logon command runs. A writable mapping defaults to writable unless configured otherwise, and its changes survive disposal. The logon command executes in the guest user's context. It can place the runner/Driver in the interactive session without making a host process's desktop APIs reach guest controls. [2]

**Do not reuse the host Notepad demo as the guest test plan.** Microsoft currently says inbox apps including Notepad and Calculator are unavailable beginning with Windows 11 24H2. Use a reviewed guest-compatible test app and list its dependencies. Installing or copying that app requires the follow-up's approval. Host app installation, profiles and licences do not transfer automatically. [3]

Windows Sandbox's newer CLI can start/list/connect/execute/share/stop and report an IP. Its documented `exec` returns an exit code but does not expose process I/O. `ExistingLogin` execution needs an active connected user session; `System` does not imply access to that desktop. Launching `cua-driver mcp` with `wsb exec` therefore does not give WSL a working MCP pipe. [14]

Microsoft's `winapp --on sandbox` is a useful source reference, not a selected dependency. Its own documentation describes a guest agent, bootstrap shares and an inbound firewall rule; a cold connection can briefly take host focus. It may adopt an already running Sandbox. This is evidence that bridging/session readiness requires work, not proof that Cua is bridged or that adoption is authorized here. This task did not install or run winapp. [15]

## Normal Windows VM: persistence and separate sessions

Choose this route when one temporary Sandbox cannot keep the required apps or serve independent agents. Each VM can have its own guest disk, user, desktop and Driver. Provisioning a clean guest, checking licensing, installing apps and reverting to a baseline are extra work; reverting cannot undo writes made through a host share or an external network service. [3, 4]

Use a disconnected virtual NIC for an offline trial. A later internal host/guest-only connection still grants network access to the host and other attached peers; it needs endpoint restrictions and authentication. An external switch or default NAT is not a no-host-access policy. A private switch excludes the host but still connects its attached guests. [20]

VMConnect Enhanced Session Mode redirects the clipboard and printers by default and plays audio on the host. It can also redirect host drives, USB and microphone input. Disable unused redirection rather than assuming a VM window keeps those resources private. Basic console mode or a tightly configured RDP session changes the integration surface, not whether the guest process has the right desktop. [5]

PowerShell Direct can run commands and copy files without guest networking. It requires a local running VM, Hyper-V administrator rights and guest credentials. It is useful for approved bootstrap/diagnostics, but a remote shell is not automatically the guest's interactive UI session or an MCP streaming tunnel. No such privileges were requested here. [6]

## WSL: a private display needs a workload boundary

WSLg deliberately integrates Linux apps with the Windows taskbar, Alt-Tab, clipboard and audio. Driving that display is not the requested separate agent desktop. Microsoft documents that WSL 2 distributions share the managed VM's kernel, network namespace and most devices, despite separate PID/mount/user namespaces. Another distribution alone is not another independent VM. [7, 8]

A practical Linux candidate is a private Xvfb/Openbox desktop with a private D-Bus/AT-SPI session. Cua's pinned source records upstream X11/Openbox behavior and explicitly supports an Xvfb plus `dbus-run-session` harness route. Xvfb renders without physical display/input devices. This supports feasibility, not a local WSL qualification. It does not demonstrate native Windows apps or every GTK/Electron/Tauri action. [11–13]

Separate these two claims:

1. **Input separation:** the Driver, app, window manager and accessibility bus share only the private display. Foreground XTest input stays on that display if there is no fallback to WSLg or a host helper.
2. **Workload isolation:** filesystem/process/network/device access is restricted by a launcher/container policy, not by `DISPLAY` or a private bus.

For the latter, the follow-up must specify a restricted root/mount set, unprivileged identity, private PID/IPC/network namespaces, capability limits and resource limits. Do not expose the host home/repo, container-engine socket, `/mnt/c`, `/mnt/wslg`, host X/Wayland sockets, user/system buses, audio sockets or unnecessary devices. No privileged container or host-namespace shortcut. Namespaces isolate specified resources but do not provide a separate kernel. No container escape resistance was audited here. [9, 10]

Disabling WSL drive automount alone is insufficient: its documentation permits manual mounts or `fstab`. Disabling Windows PATH append alone is insufficient: an absolute Windows executable can still be launched when interop is enabled. Remove host filesystem/socket access and Windows executable interop from the workload itself. Global `.wslconfig` changes such as disabling WSLg or networking affect other distributions; do not use them to alter this working setup. [9]

Cua's Linux backend discovers a missing session bus from `/run/user/<uid>/bus` or another desktop process's environment. It is a convenience fallback, not isolation. The launcher must provide the exact private bus and prevent access to foreign buses/processes. A failed private display/bus must cause refusal, never automatic adoption of the host-integrated desktop. Native Wayland is compositor-specific; the experimental nested Cua compositor and incomplete KDE/Hyprland coverage are not simpler proven sandbox alternatives. [12, 13]

## Host channels to account for

| Channel | Required boundary and remaining risk |
| --- | --- |
| Windows/UIA targets | Resolve PID, HWND and lifetime **in the guest**, not through the current host PowerShell identity peer. Include environment identity/generation with refs so a recycled guest/host PID cannot cross the boundary. |
| Focus, keyboard, pointer | Guest Driver must run in the intended interactive desktop. Send native foreground input there, not to the host's Sandbox/VM viewer with host `SendInput`. Viewer connection/reconnect can affect host focus; test it separately from steady-state input. A minimized/disconnected guest may refuse capture/input. |
| Files and execution | No default host mounts; one reviewed read-only import and an explicit bounded export if needed. Shell/build tools running in host Pi are still host tools. Running a sandboxed UI does not sandbox the agent's arbitrary host shell. |
| Clipboard | Disable Windows RDP/Sandbox clipboard redirection and WSLg clipboard paths. Confirm both directions with disposable sentinel data; do not read a real personal clipboard. |
| Network | Offline by default for the first trial. A live model/bridge adds intentional network authority. Bound endpoints, authentication and cancellation; ordinary NAT is not isolation from host/LAN. |
| Interop and devices | No host Windows executable bridge inside a Linux workload; no unnecessary GPU, microphone, camera, USB, printer or audio socket/device redirection. |
| Shared guest apps | One guest can isolate the host while apps/agents inside that guest interfere with each other. Safe/YOLO remains a separate per-window policy within that environment. |
| Resources and shutdown | CPU/RAM/disk limits and owned process/guest identity. Stop only the created environment after exporting approved evidence; never a human's pre-existing Sandbox/VM or all WSL distributions. |

A Windows virtual desktop/workspace is a view arrangement, not another OS. Even Win32 desktop objects, which constrain messages/input, are not a substitute for guest filesystem, network and credential boundaries. [16]

## Pi and Cua Driver topology

The working extension currently starts the **host Windows** Driver through WSL executable interop, using MCP stdio and a separate **host Windows** identity peer. That path was qualified on the host, not in any guest. Changing only its binary path, or selecting YOLO, does not redirect both components into a sandbox. A Linux binary cannot replace its Windows lifetime peer either. No provider/API change was made in this research. [17]

The inspected `cua-driver-rs-v0.32.0` tag resolves to `58aba84b5b83d77e7e2b0f006547699eb594e50d`. It offers these distinct boundaries:

- `mcp --direct --embedded` owns a local runtime over stdin/stdout. Put client and Driver in the same guest/session, or explicitly relay that pipe through a trusted broker.
- Daemon mode uses Unix sockets on Linux and current-user Windows named pipes. A guest socket/pipe name is not a host-reachable address.
- An optional MCP HTTP endpoint binds to guest `127.0.0.1`, requires a launcher-provided bearer token and rejects browser-origin requests. It is disabled unless configured. It remains legacy MCP; modern metadata/discovery requests are refused. An authenticated tunnel/broker and exact client-version qualification are still needed from WSL. Do not rebind it to a public address or assume host `localhost` means guest `localhost`.
- A different private typed-envelope HTTP carrier also exists. It is loopback-only, unauthenticated and explicitly not a released Fleet setup guide. Do not confuse it with the authenticated MCP endpoint or expose it directly.

These are inspected source mechanisms, not guest transport passes. The binary was not built or run in a guest. [18]

Possible placements:

| Placement | Benefit | Cost or unresolved requirement |
| --- | --- | --- |
| Pi/client and Driver inside Windows guest | Local stdio and guest-local native target identity; host UI APIs need not be exposed | Need guest Node/Pi/runtime payloads and an interactive Windows session. Online model access/credentials are an intentional exception to offline isolation. Current WSL-specific extension is not already qualified as a Windows-guest package. |
| Pi remains in WSL; guest broker owns Driver | Retains the current agent environment and can isolate its computer-use endpoint | New authenticated transport, guest identity/generation, guest-session launcher, timeouts/cancellation and no-host-fallback checks. Host shell/file tools remain outside the sandbox. |
| Linux client/Driver inside restricted WSL workload | Private X11/AT-SPI and local stdio can avoid a network endpoint | Linux apps only; private environment must not expose host files/interop/sockets. Shared kernel remains. |

For genuinely untrusted agent code, isolate that code and its other tools too. A host Pi agent with unrestricted host Bash is not contained merely because its UI tool targets a guest.

## Observed local prerequisites and gaps

The selected read-only probes and exact values are in [sandbox-local-facts.json](sandbox-local-facts.json). Queries used CIM OS/CPU/memory/disk metadata, `Get-WindowsOptionalFeature`, `Get-Command wsb.exe`, `Get-AppxPackage -Name WindowsSandbox`, `Get-Service vmms`, `wsl --version`, `wsl --list --verbose`, selected environment variables, `findmnt`, `/etc/wsl.conf`, `/etc/os-release` and command lookup. They did not inspect real documents or clipboard contents.

- Windows 11 Pro, build 26200; about 31.4 GiB RAM, 8 cores/16 threads and about 214 GiB free on C:. A hypervisor is present and firmware virtualization reports enabled. This meets the edition/basic resource direction, not proof of a working Sandbox.
- `WindowsSandbox.exe` at the checked System32 path, `wsb.exe` command lookup and the current user's WindowsSandbox package query were absent. Do not infer a complete installation audit from those lookups.
- Both Sandbox and full Hyper-V optional-feature queries require elevation. Their state is **unknown**, not “disabled”. `vmms` is running, but that does not grant this session VM management rights or prove a ready guest.
- CIM reports SLAT false alongside the active hypervisor. This is not accepted as a hardware incompatibility verdict. Microsoft notes that requirements are not displayed normally on an active Hyper-V host; resolve prerequisites through an approved operator check before setup. [4]
- One Ubuntu 24.04 WSL 2 distribution is running. WSL/WSLg and the integrated display variables are present. Its configuration enables writable Windows drive automount, `fstab`, Windows executable interop and Windows PATH append. It is the working environment, not a restricted workload.
- Xvfb is installed. No Xorg or cage command was found by the scoped lookup. No virtual display, private bus, Linux Driver, container or guest was started.

Global `.wslconfig`, guest licence/image/app readiness, exact feature state, available guest transport and actual cold/warm timing remain gaps. No elevated retry, WSL restart or guest setup was attempted. Source documentation's performance descriptions must not become local benchmark numbers.

## Proposed next PoC: offline guest control first

**Not executed or authorized by this task.** Propose a separate Task before any setup. This first slice proves the guest desktop/Driver and detects sampled host side effects; it deliberately does not claim live Pi connectivity or adversarial isolation.

### Required approval and setup

1. User approves enabling/installing Windows Sandbox if needed, a possible Windows reboot, and a disposable guest lifetime. Do not adopt an existing Sandbox; if one is running, stop and ask.
2. User approves a reviewed, pinned payload: Windows Cua Driver 0.32.0 with hashes, a deterministic guest UI fixture and a local MCP runner. Prefer a small portable Win32 fixture, or an upstream WPF fixture published self-contained with its exact runtime payload. Upstream fixture sources exist but their binaries are not shipped in the repository. Availability/build tools and guest compatibility are explicit prerequisites, not assumptions. [19]
3. User approves the exact read-only bootstrap folder and new writable outbox, both containing no real data; network/clipboard/microphone/camera/printer disabled. Any vGPU/Protected Client setting and incompatibility fallback is reviewed, not silently relaxed.
4. User explicitly authorizes one disposable host sentinel window, test clipboard sentinel values and a disposable host canary file outside the mapped directories. No unrelated windows, personal clipboard or real file contents are observed.
5. Agree how to close the guest and remove only owned payload/outbox/sentinel artifacts. Feature enablement is a separately approved persistent change; disposing the guest does not revert it.

### Observable trial

- Record host OS/Sandbox/client version, guest identity/generation, fixture and Driver hashes, configuration, display/session readiness and cold startup time. Keep the viewer connection phase separate from the input phase.
- Logon starts the runner and Driver as the guest's interactive user, with no host native input helper. The runner uses the production MCP path inside the guest; no model/API key is needed for this slice.
- Discover a genuinely new fixture window; read its accessibility tree and scoped screenshot. Verify one empty editor, then write a unique value by current semantic ref. Fresh tree, PNG and fixture-owned state must agree.
- Exercise one bounded foreground action in the guest with the viewer visible but not selected, and again while the human-authorized host sentinel has focus. Record host foreground window, cursor position and sentinel input before/during/after; require no leaked host keystrokes or pointer action. Do not infer this from a successful Driver result. Minimized/disconnected/locked behavior can refuse; it must not fall back to the host or be reported as success.
- Verify the guest cannot read the unmapped canary or write outside the approved outbox through mapped host paths; sentinel hash/content unchanged. Test only disposable clipboard values in both directions. Check configured network restrictions with bounded local probes, without scanning the LAN. A denied sampled path is not proof that every host path or device is inaccessible.
- Export bounded JSON and original PNGs, including exact refusals/unknown outcomes. Close only test apps, release the owned Driver, close the owned guest, then verify its processes/connection are gone and host sentinels unchanged. Confirm a fresh guest starts without the old fixture value if a second launch is separately approved.

**Pass:** exact guest state changes, matching tree/pixels, no observed host input leak in the measured interval, declared channels disabled or bounded, and verified owned cleanup. **Fail/block:** wrong desktop identity, missing fixture/runtime, unavailable capture/input, unexplained host focus/input change, unknown channel policy or cleanup failure. Unknown delivery requires readback; it is not a reason to repeat input blindly.

### Later live Pi bridge gate

Only after that pass, propose WSL Pi → authenticated relay → guest-local broker/Driver. A separate approval names the host/guest endpoints, credential lifetime, network exposure and guest interactive launcher. Qualify MCP version, PNG delivery, target identity, environment generation, missing/wrong guest rejection, cancellation/EOF and cleanup. Old guest refs and disconnected transport must fail closed without host fallback. An offline mailbox broker is another possible route, but would need its own framing, permissions, replay and lifetime contract; mapped JSON files are not already a working MCP transport.

If saved app installations or parallel agents are required instead, use a fresh Windows VM with the same observable checks and explicit image/licensing/redirection policy. Keep the WSL/Linux trial separate so Linux feasibility is never presented as Windows app coverage.

## Acceptance review

| LPT-364 check | Result in this research |
| --- | --- |
| Native Windows and isolated WSL comparison | Pass as research: routes, prerequisites, app/state/concurrency limits and Pi/Driver placement above, backed by primary docs and pinned source. Guest behavior remains untested. |
| Host channels and isolation versus convenience | Pass as research: channel table, default redirection, WSL mounts/interop/bus fallback and host Pi authority are explicit. No all-channels or escape-proof claim. |
| Bounded next live qualification | Pass as proposal: approval prerequisites, guest observations, host sentinels, refusal/unknown handling and owned cleanup are specified. No live experiment performed. |
| Independent of host YOLO/Safe work | Pass: only research/navigation/evidence documents changed. No runtime/IDE code or persistent machine setup changed. |

No automated or native feature tests were run for this documents-only research. Source links and local metadata were reviewed; all live guest outcomes remain future checks.

## Sources

Primary pages were read on 2026-10-02. Live documentation can change; pinned Cua links identify the inspected release source. Upstream test ledgers are the upstream author's evidence, not runs reproduced here.

1. [Microsoft: Windows Sandbox overview](https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/).
2. [Microsoft: Windows Sandbox configuration and defaults](https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-configure-using-wsb-file).
3. [Microsoft: installation prerequisites/inbox app limit](https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-install); [FAQ: app, instance, persistence and OS-build limits](https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-faq).
4. [Microsoft: Hyper-V OS/hardware/resource requirements and active-hypervisor check limitation](https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/host-hardware-requirements).
5. [Microsoft: VMConnect Enhanced Session redirection and defaults](https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/enhanced-session-mode).
6. [Microsoft: PowerShell Direct requirements, command execution and file transfer](https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/manage/manage-windows-virtual-machines-with-powershell-direct).
7. [Microsoft: WSL 2 shared VM/kernel/network/device architecture](https://learn.microsoft.com/en-us/windows/wsl/about).
8. [Microsoft: integrated WSLg GUI and clipboard](https://learn.microsoft.com/en-us/windows/wsl/tutorials/gui-apps); [WSLg source README: Weston/RDP clipboard and audio integration](https://github.com/microsoft/wslg#weston).
9. [Microsoft: WSL configuration scope, automount, interop, WSLg and networking](https://learn.microsoft.com/en-us/windows/wsl/wsl-config).
10. [Linux man-pages: namespaces](https://man7.org/linux/man-pages/man7/namespaces.7.html); [network namespace and abstract socket boundaries](https://man7.org/linux/man-pages/man7/network_namespaces.7.html).
11. [X.Org: Xvfb virtual display without physical input/display](https://www.x.org/archive/X11R7.6/doc/man/man1/Xvfb.1.xhtml).
12. [Cua 0.32.0 platform support](https://github.com/trycua/cua/blob/58aba84b5b83d77e7e2b0f006547699eb594e50d/docs/content/docs/cua-driver/concepts/platform-support.mdx); [accepted upstream desktop action ledger](https://github.com/trycua/cua/blob/58aba84b5b83d77e7e2b0f006547699eb594e50d/libs/cua-driver/docs/action-support.md); [Xvfb/D-Bus runner](https://github.com/trycua/cua/blob/58aba84b5b83d77e7e2b0f006547699eb594e50d/scripts/ci/linux/run-rust-e2e.sh#L13-L21).
13. [Cua 0.32.0 Linux session-bus discovery](https://github.com/trycua/cua/blob/58aba84b5b83d77e7e2b0f006547699eb594e50d/libs/cua-driver/rust/crates/platform-linux/src/session_bus.rs#L1-L105); [representative desktop qualification gaps](https://github.com/trycua/cua/blob/58aba84b5b83d77e7e2b0f006547699eb594e50d/libs/cua-driver/docs/linux-desktop-validation.md).
14. [Microsoft: Sandbox CLI and exec I/O/session limits](https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-cli).
15. [Microsoft: winapp Sandbox execution, bootstrap, focus and input-readiness limits](https://learn.microsoft.com/en-us/windows/apps/dev-tools/winapp-cli/sandbox-execution).
16. [Microsoft: Win32 desktops and the input desktop](https://learn.microsoft.com/en-us/windows/win32/winstation/desktops).
17. [Current host McpDriver](../../src/driver.ts); [host window identity](../../src/window-identity.ts); [qualified host Safe result](../safe-windows-results.md).
18. Cua 0.32.0 [CLI/direct mode](https://github.com/trycua/cua/blob/58aba84b5b83d77e7e2b0f006547699eb594e50d/libs/cua-driver/rust/crates/cua-driver/src/cli.rs#L18-L36), [Windows named-pipe ownership](https://github.com/trycua/cua/blob/58aba84b5b83d77e7e2b0f006547699eb594e50d/libs/cua-driver/rust/crates/cua-driver/src/serve.rs#L1661-L1725), [MCP HTTP authentication/bind](https://github.com/trycua/cua/blob/58aba84b5b83d77e7e2b0f006547699eb594e50d/libs/cua-driver/rust/crates/cua-driver/src/mcp_http.rs#L1-L161), [required bearer token](https://github.com/trycua/cua/blob/58aba84b5b83d77e7e2b0f006547699eb594e50d/libs/cua-driver/rust/crates/cua-driver/src/mcp_http.rs#L367-L393), [legacy HTTP limitation](https://github.com/trycua/cua/blob/58aba84b5b83d77e7e2b0f006547699eb594e50d/libs/cua-driver/docs/mcp-protocol-and-skills.md#L113-L119), and [separate private envelope carrier warning](https://github.com/trycua/cua/blob/58aba84b5b83d77e7e2b0f006547699eb594e50d/libs/cua-driver/docs/private-envelope-http.md).
19. [Cua 0.32.0 source-first fixtures and build dependencies](https://github.com/trycua/cua/blob/58aba84b5b83d77e7e2b0f006547699eb594e50d/libs/cua-driver/tests/fixtures/README.md).
20. [Microsoft: Hyper-V external/internal/private switch boundaries](https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/plan/plan-hyper-v-networking-in-windows-server).