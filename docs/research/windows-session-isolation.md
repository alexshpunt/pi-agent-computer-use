# Windows session isolation for agents (LPT-848)

Can computer use run in a separate Windows session for the agent? The aim is an agent with its own account, desktop, clipboard and input that never touches the human's session, without a Windows Sandbox. Checked live on a Windows 11 test machine on 2026-10-20.

## What exists

- **Agent Workspace and Microsoft Execution Containers (MXC).** Windows' agent isolation is published as [MXC](https://github.com/microsoft/mxc), MIT, SDK v1.0.1 at the time of this check. Its `isolation_session` backend asks Windows to provision a fresh agent user account with its own session, runs a process there, and removes both afterwards.
- **Supported builds.** Per the [OS-version table](https://github.com/microsoft/mxc/blob/main/docs/backends/process-container/os-version-support.md), session isolation needs Windows 11 25H2 26200.9550 or later, 24H2 26100.9550, or 26H2 26300.9550. The two test machines run 25H2 26200.9711 Professional with VBS on, so both qualify. Nothing had to be enabled.
- **Ways to call it.** The `wxc-exec.exe` CLI with a JSON request, a one-shot SDK call, or the lifecycle API (provision, start, exec, stop, deprovision) for several commands in one session. Network access cannot be restricted, so requests must state unrestricted egress and ingress. MXC says no profile is a security boundary yet.

## Live results

All steps used `wxc-exec.exe --experimental` from MXC v1.0.1 and ran as the normal, non-elevated user.

| Check | Result |
| --- | --- |
| Start a session | Works. The workload ran as the OS-named user `S7-X6` in session 3, while the human uses session 1. |
| Desktop | Interactive, 640×480, with a foreground window. Notepad opened its own window. |
| Screen capture | `CopyFromScreen` works inside the session. |
| `SendInput` | Accepted (returned 1). The MXC docs say it is denied; on this build it was not. |
| CUA driver | `cua-driver serve` ran in the session. From the host, `list_windows` found its Notepad, `get_window_state` returned a screenshot and UI tree, and `type_text` was delivered in both background and foreground modes. Notepad's status bar moved to column 35 and the title showed it as modified. |
| Files | The agent user cannot read the caller's profile. A world-readable folder (here `C:\Users\Public`) worked for the runtime; MXC's lifecycle API also offers an `ephemeralWorkspacePath` shared with the caller. |
| Network | The session has its own loopback. It can connect out to the host's `127.0.0.1` (SSH on port 22 answered), but the host cannot connect in to ports the session listens on. Binding a fixed port inside could also fail with "address in use". A reverse relay solves this: a host listener on an OS-chosen port, and a small relay in the session that dials out to it and pipes each connection to the local driver. |
| Cleanup | Removing a session depends on its `wxc-exec` process ending normally. Killing `wxc-exec`, or leaving detached apps such as Notepad running, left two sessions (4 and 9) alive with the agent's Notepad in them. The normal user cannot stop processes in those sessions, and one-shot runs have no lifecycle ID to deprovision. |

The probe is in [session-isolation-probe/](session-isolation-probe/): `session.ps1` starts the driver and the session-side relay, `host-reverse.ps1` is the host relay, and `probe.live.ts` drives them from WSL. The runtime copy goes to `C:\Users\Public\pi-mxc`. These are research files, not part of the package.

## What it would give us

- **Several agents with their own desktops on one machine.** Windows runs one Sandbox at a time, while each isolation session is a separate user and session. That gives several agents real foreground input without fighting each other or the human.
- **No VM start.** It is faster than Windows Sandbox: a session started in seconds instead of 15–30 s.
- **Real isolation from the human's input, clipboard and windows.** It is still not a security boundary, by Microsoft's own statement.

## Limits found

- The desktop is 640×480. Changing it was not tried.
- Cleanup must be deliberate. A provider must use the lifecycle API (provision, then deprovision), end every process it started inside the session, and never kill `wxc-exec`.
- The API is still preview (`Windows.AI.IsolationSession.Preview`) and may change between Windows updates.

## Recommendation

Build a session provider on top of this, like `open_sandbox`: `open_session` provisions an isolated session through the MXC lifecycle API, starts the CUA driver and the reverse relay inside it, returns a `computer:session/...`-style address, and deprovisions on close. It would make several simultaneous agents (LPT-630) possible with foreground input. That is a new provider with a new dependency (MXC binaries), so it needs an owner decision.
