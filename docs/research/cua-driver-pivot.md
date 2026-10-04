# Context research: Cua Driver as the shared backend

This is the pre-implementation inventory at revision 6cb3e15. The later [CUA delivery report](../cua-browser-results.md) records which routes were actually qualified and the accepted foreground compromise.

## Question

Which existing Windows browser, capture and human-visibility features can Cua Driver replace without changing our current guarantees?

## Findings

### Desktop already uses CUA; the browser does not

Our desktop tools use a Windows Cua Driver MCP process from WSL. The client requires version 0.32.0. Our owned visible browser uses a separate Windows worker and `playwright-core`. Image sizing, retained-original crops, focus and the Vision debug site are our own layers.

**Evidence:** `src/driver.ts`, `src/index.ts`, `src/browser-playwright.ts`, `src/browser-image-pipeline.ts`, `src/vision-images.ts`; repository revision `6cb3e15` plus the unfinished LPT-372 working-tree changes. This is source inspection, not a new live run.

### The installed pin and current source are different

The inspected 0.32.0 tag is `58aba84b5b83d77e7e2b0f006547699eb594e50d`. Upstream HEAD was `fcb386f4f958d1357af31ccb0056376f06d9db37`. The 0.33.1 release tag points to `a9baa8d107fba8b0aef5a4ed6233e498e88d14d0`.

The changelog lists Windows browser installation-path and DPI/window-binding fixes in 0.33.0, and foreground input draining in 0.33.1. The shared browser tools, image helper and cursor-overlay source did not differ between the inspected 0.32.0 tag and HEAD. The Windows browser adapter did differ. Newer documentation is not proof that our pinned runtime works correctly in this environment.

**Evidence:** `git ls-remote`, tag fetch and revision comparison; [changelog](https://github.com/trycua/cua/blob/fcb386f4f958d1357af31ccb0056376f06d9db37/libs/cua-driver/rust/CHANGELOG.md). No installed driver was updated.

### CUA can launch a separate browser without Playwright

`browser_prepare` accepts `allow_launch: true` and `profile: {mode: "isolated_new"}` under an explicit session. A PID is optional for this launch. The Windows implementation selects an attested system Chrome/Edge installation and refuses untrusted or user-controlled installation paths. The returned process must still be correlated with an exact native window before browser input.

The isolated profile has driver-owned cleanup. An existing signed-in profile is a different, explicitly authorized route. It is not needed for our owned-browser workflow, and must not become a fallback when isolated launch fails.

**Evidence:** [BrowserPrepareTool](https://github.com/trycua/cua/blob/58aba84b5b83d77e7e2b0f006547699eb594e50d/libs/cua-driver/rust/crates/cua-driver-core/src/browser/tools.rs), [profile preparation](https://github.com/trycua/cua/blob/58aba84b5b83d77e7e2b0f006547699eb594e50d/libs/cua-driver/rust/crates/cua-driver-core/src/browser/prepare.rs), [official browser guide](https://cua.ai/docs/how-to-guides/driver/drive-a-web-page). Launch and cleanup from our WSL host remain unverified for this route.

### Browser perception and input already have typed CDP tools

`get_browser_state` binds an exact window and provides session-scoped target/tab IDs. `semantic_v2` combines accessibility, DOM and layout information. Browser click accepts a ref or viewport CSS coordinates. Browser type supports replacement and text/keystroke modes. Browser pointer supports hover, right click, double click, scroll and drag, including coordinate destinations.

Trusted Windows CDP input is documented as working without taking foreground focus. CUA does not silently substitute synthetic DOM events or foreground input after a refusal. We must keep that distinction too.

**Evidence:** [browser tool registry and schemas](https://github.com/trycua/cua/blob/58aba84b5b83d77e7e2b0f006547699eb594e50d/libs/cua-driver/rust/crates/cua-driver-core/src/browser/tools.rs), [pointer parser](https://github.com/trycua/cua/blob/58aba84b5b83d77e7e2b0f006547699eb594e50d/libs/cua-driver/rust/crates/cua-driver-core/src/browser/pointer.rs), [official browser guide](https://cua.ai/docs/how-to-guides/driver/drive-a-web-page). No new native browser test has established this in our extension.

### Short hints and stable hints are different contracts

CUA refs use `p<snapshot>:<index>`. A newer snapshot of the same tab, navigation or reconnect invalidates them. Renaming a ref to `a` makes it shorter, not stable across observations. Our unfinished LPT-372 requires the same DOM node to retain its hint and forbids a retired hint from targeting a replacement node. Source inspection did not establish a public CUA identity contract sufficient to promise that behavior.

Focus and short snapshot-scoped aliases can still hide the internal IDs from the model. Stable identity would need separate evidence; stale refs must never be silently rebound using a matching label alone.

**Evidence:** `schema_ref` and `require_explicit_session` in [browser tools](https://github.com/trycua/cua/blob/58aba84b5b83d77e7e2b0f006547699eb594e50d/libs/cua-driver/rust/crates/cua-driver-core/src/browser/tools.rs); [LPT-372](https://linear.app/alexshpunt/issue/LPT-372).

### The driver has a real human-visible cursor overlay

Windows creates a transparent, click-through, non-activating overlay. Cursor settings require an explicit session: enabled, motion, theme and state. Browser actions feed that overlay through the Windows browser adapter. The adapter hides browser cursor feedback for an inactive tab and skips it when a screen position is unavailable. An invisible or inactive page therefore does not guarantee visible cursor feedback.

The desktop capture path excludes the driver's cursor/session pill with Windows display affinity and reports exclusion status. The clean model image and human overlay are separate surfaces. A clean screenshot alone cannot prove that the human saw the cursor.

No public rectangle/text/highlight drawing tool was found in the inspected browser registry and cursor API. A generic native annotation overlay is not an already-available feature or an established small change.

**Evidence:** [cursor reference](https://cua.ai/docs/cua-driver/reference/mcp-tools/agent-cursor), [Windows overlay](https://github.com/trycua/cua/blob/fcb386f4f958d1357af31ccb0056376f06d9db37/libs/cua-driver/rust/crates/platform-windows/src/overlay.rs), `visualize_browser_action` in the [Windows browser adapter](https://github.com/trycua/cua/blob/fcb386f4f958d1357af31ccb0056376f06d9db37/libs/cua-driver/rust/crates/platform-windows/src/browser_platform.rs). Overlay behavior on our host is not yet observed.

### Native capture scaling is not our MKS image policy

The shared native PNG resize helper uses Lanczos3. `max_image_dimension: 0` disables its cap. Window image-limit resolution supports a canonical per-call override. The Windows desktop implementation inspected here applies its explicit positive per-call cap and otherwise keeps native size; do not infer identical global/session precedence for every capture route.

The browser screenshot path captures the exact tab viewport through CDP and returns raster-to-CSS ratios. Its inspected schema does not expose `max_image_dimension`, and the capture implementation does not run the native resize helper. Passing an extra field is not proof that it controls the browser PNG.

The selected MKS2021/500px policy would still need an image layer, or an explicit change to that policy. Any extra image transform must be composed with the driver's transform exactly once.

**Evidence:** [image helpers](https://github.com/trycua/cua/blob/58aba84b5b83d77e7e2b0f006547699eb594e50d/libs/cua-driver/rust/crates/cua-driver-core/src/image_utils.rs), `GetDesktopStateTool` in [Windows tools](https://github.com/trycua/cua/blob/fcb386f4f958d1357af31ccb0056376f06d9db37/libs/cua-driver/rust/crates/platform-windows/src/tools/impl_.rs), `capture_tab_screenshot` in [browser engine](https://github.com/trycua/cua/blob/58aba84b5b83d77e7e2b0f006547699eb594e50d/libs/cua-driver/rust/crates/cua-driver-core/src/browser/engine.rs).

### Windows zoom is not a retained-original crop

Windows `zoom` uses the scale from the session's prior window screenshot, then takes a fresh native window capture. It adds 20% padding on each side, resizes wider results to 500px with Lanczos3 and encodes JPEG. `from_zoom` uses stored zoom geometry for native window input.

It does not provide our no-recapture, exact-bounds, nested retained-original PNG crop contract. It addresses a native window, not a CDP tab viewport. Calling it after a browser snapshot is not an established browser crop route.

**Evidence:** `ZoomTool` in [0.32.0 Windows tools](https://github.com/trycua/cua/blob/58aba84b5b83d77e7e2b0f006547699eb594e50d/libs/cua-driver/rust/crates/platform-windows/src/tools/impl_.rs), [crop/JPEG helper](https://github.com/trycua/cua/blob/58aba84b5b83d77e7e2b0f006547699eb594e50d/libs/cua-driver/rust/crates/cursor-overlay/src/capture_utils.rs), [screen reference](https://cua.ai/docs/cua-driver/reference/mcp-tools/screen), our [crop contract](../browser-crop.md).

### Browser tab and key parity is not established

The inspected public browser registry provides state, prepare, navigate, click, type, pointer, dialogs, upload and download. It has no standalone browser tab-create, tab-activate, tab-close or arbitrary key-press tool. Names reserved for cursor badges are not registered tools. Observing multiple tabs is supported; that does not establish every tab lifecycle action our current browser tools perform.

Native window actions may cover some missing operations, but their tab targeting and foreground effects must be verified before claiming parity. The absence of a public tool is not permission to reintroduce Playwright or arbitrary page JavaScript through a hidden fallback.

**Evidence:** `register_browser_tools` in [browser tools](https://github.com/trycua/cua/blob/58aba84b5b83d77e7e2b0f006547699eb594e50d/libs/cua-driver/rust/crates/cua-driver-core/src/browser/tools.rs); inspected schema/source search for tab/key tools; `src/browser-tools.ts`.

### A primary-display API is not arbitrary monitor support

Windows `get_desktop_state` captures the primary display at physical pixel size, without a UIA walk. Its current schema does not select another monitor. The overlay spans the virtual screen, which is a different geometry. Safe ownership of one window does not authorize reading the whole display.

**Evidence:** [Windows capture](https://github.com/trycua/cua/blob/fcb386f4f958d1357af31ccb0056376f06d9db37/libs/cua-driver/rust/crates/platform-windows/src/capture.rs), `GetDesktopStateTool` schema; [LPT-376](https://linear.app/alexshpunt/issue/LPT-376). No full-display capture was performed for this research.
