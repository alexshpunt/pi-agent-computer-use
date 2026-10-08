---
name: develop-computer-use
description: Set up and clean up local Pi Agent Computer Use loading when developing, fixing, or verifying this extension in a branch or worktree. Use before changing extension code or reloading Pi for a local check. Normal sessions use the global package.
---

# Develop computer use in a worktree

Load exactly one copy. The global package is the default; a task session must temporarily load its own checkout instead. A second copy causes tool conflicts.

## Set up the task session

1. Use Teleport to create and enter the task's branch/worktree. Read the installed Pi package and settings docs. Inspect personal and project settings to find the global computer-use package source. Resolve relative sources from their settings directory, not the working directory. Do not change personal settings.
2. Record the contents and Git status of files you will touch. Keep backups in the ignored `.tmp/` directory and preserve unrelated settings and other agents' changes.
3. In this worktree's `.pi/settings.json`, override the same global package source with `extensions: []`. Use a normal package entry, not `autoload: false`. Preserve its other resource filters and unrelated entries. For the current local-path install, the entry looks like this (find the actual source; do not copy a machine path blindly):

   ```json
   {
     "packages": [
       { "source": "/absolute/path/to/global/pi-agent-computer-use", "extensions": [] }
     ]
   }
   ```

4. Create or temporarily enable one `.pi/extensions/computer-use.ts` loader:

   ```ts
   export { default } from "../../src/index.ts";
   ```

   Disable any other computer-use loader or package entry that loads this checkout. Do not add `-e` on top of normal loading.
5. Check dependencies in this worktree. A fresh Git worktree has no `node_modules`; loading the global checkout does not provide its dependencies. Run `npm ls --depth=0` and confirm `sharp` can be imported from the worktree. If dependencies are missing, run `npm ci --ignore-scripts` using the committed lockfile, then repeat the import check. Do not change dependency versions, global installs, native runtime selection, or machine settings for this setup.
6. Treat the settings and loader as temporary session setup. They are ignored by Git. Do not stage, commit, or push them; use explicit staging paths.

## Verify before reloading

7. Launch a separate Pi process from the worktree with its normal configuration, an in-memory session, and no model prompt. Do not use `--no-extensions` or an explicit entrypoint, which bypass the setup being checked. This startup-only probe requests command metadata and exits on EOF:

   ```sh
   printf '%s\n' '{"id":"startup","type":"get_commands"}' | \
     pi --mode rpc --no-session --approve --no-mcp --offline
   ```

   Require exit code zero and no extension load errors. Inspect the `computer-mode` and `computer-debug` command origins: both must name this worktree's loader, not the global checkout. Missing or duplicate commands are a failure. This checks loading, not native Windows behavior.
8. Only after startup passes, reload with `pi_extension_dev_reload_self` and explicit acceptance of state loss. Include the worktree and exact live verification steps in the continuation. Follow the `pi-feature-verification` skill: exercise the changed behavior, inspect agent-facing results, and capture the real viewport with `inspect_tui` when the result is visible. Do not rely on old runtime state or window references after reload.

## Restore global loading

9. Before review, commit, push, or ending a paused/canceled task, remove your temporary loader and package override, or restore the previous contents. Restore only your own edits. Check both the diff and index for accidental setup changes; ignored files still affect Pi and must also be checked.
10. Repeat the startup probe with restored settings. Require the commands to come from the global package and no extension errors. Reload Pi to return the task session to global loading before Git work or worktree removal. If the user requests more changes, repeat setup and cleanup.
11. Remove disposable backups after useful evidence is recorded. Report any cleanup or startup blocker rather than leaving a broken local loader behind.
