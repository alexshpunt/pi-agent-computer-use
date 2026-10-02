# Pi Agent Computer Use

A standalone computer-use proof of concept for Pi. The final goal is an extension for [Pi Agent IDE](https://github.com/alexshpunt/pi-agent-ide), using the IDE's shared, intent-based tool primitives.

## Why a separate extension

Pi Agent IDE already has vision and other capabilities beyond code work. Its scope has grown. Over time, the IDE should return to code editing, code understanding, debugging, and related development work. This extension should become the computer-use implementation.

We want a full computer-use library built around simple intentions and shared structures. Instead of adding an unrelated tool for every backend, it should provide computer-use resources through primitives such as `read` and `insert`, with providers for vision, browsers, application processes, images, and UI interaction. The goal is to teach the agent to use the applications we care about.

The exact implementation is still open. These are project intentions, not capabilities available today.

## Migration boundary

First prove computer use through independent tools, without an IDE dependency. Integration and gradual extraction come later. Do not change the working IDE for the PoC. Any future extraction experiment must use an isolated IDE branch/worktree and check the two extensions together in a separate environment before changes reach the normal installation.

The ownership of shared infrastructure, including processes, terminals, browser reads, and images, still needs investigation. It is not decided simply because a resource appears in this pitch.

## Current state

The standalone PoC uses Cua Driver 0.32.0 to reach the Windows desktop from Pi in WSL. Its four experimental tools cover authorized-window discovery, observation, grounded actions, and runtime cleanup. A live isolated Pi run edited and verified an owned Notepad document without IDE. See [the result and limits](docs/standalone-poc-results.md) and [setup](docs/standalone-poc.md). This is not the final provider API or a selected migration route.

- [Linear project](https://linear.app/alexshpunt/project/pi-agent-computer-use-614e5fa78124)
- [Research task: define the first safe migration](https://linear.app/alexshpunt/issue/LPT-355/define-the-first-safe-computer-use-migration)
- [Research references](docs/research-references.md)

[External source research](docs/research/external-implementations.md) is available. The current task is [the standalone Windows PoC](https://linear.app/alexshpunt/issue/LPT-356/prove-standalone-windows-computer-use-from-pi-in-wsl). IDE inventory, migration, and coexistence work are deferred until this independent path has live evidence.
