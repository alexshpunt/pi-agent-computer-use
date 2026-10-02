# Pi Agent Computer Use

A planned extension for [Pi Agent IDE](https://github.com/alexshpunt/pi-agent-ide) that adds computer use to Pi agents through the IDE's shared, intent-based tool primitives.

## Why a separate extension

Pi Agent IDE already has vision and other capabilities beyond code work. Its scope has grown. Over time, the IDE should return to code editing, code understanding, debugging, and related development work. This extension should become the computer-use implementation.

We want a full computer-use library built around simple intentions and shared structures. Instead of adding an unrelated tool for every backend, it should provide computer-use resources through primitives such as `read` and `insert`, with providers for vision, browsers, application processes, images, and UI interaction. The goal is to teach the agent to use the applications we care about.

The exact implementation is still open. These are project intentions, not capabilities available today.

## Migration boundary

Start from what already exists in Pi Agent IDE and move it gradually. Do not change the working IDE during preparation. Any future extraction experiment must use an isolated IDE branch/worktree and check the two extensions together in a separate environment before changes reach the normal installation.

The ownership of shared infrastructure, including processes, terminals, browser reads, and images, still needs investigation. It is not decided simply because a resource appears in this pitch.

## Current state

This repository contains project context and research references only. There is no extension code, package, or installation command yet. No backend, public API, dependency, or migration route has been selected.

- [Linear project](https://linear.app/alexshpunt/project/pi-agent-computer-use-614e5fa78124)
- [Future research task: define the first safe migration](https://linear.app/alexshpunt/issue/LPT-355/define-the-first-safe-computer-use-migration)
- [Research references](docs/research-references.md)

The research task will examine the IDE's existing boundaries, compare the supplied references, and propose a bounded first migration and a way to verify coexistence. Research and implementation have not started.
