# CUA Windows browser paint diagnosis

## Status

Native semantics and native window pixels can disagree. The exact cause and a no-focus fix are not established. After the controls below, the user explicitly approved automatic CUA foreground on the exact owned browser before every overview and zoom, accepting keyboard-focus switching. This compromise is implemented and verified in [the delivery report](../cua-browser-results.md); it is not a paint-readiness guarantee. Earlier sections retain the permissions and outcomes of each diagnostic run. No patched Driver was built, installed or tested. The official 0.33.1 runtime is unchanged.

## What we observed

The local fixture has one button. A click changes a large heading and the whole background: yellow STAGE ZERO, green STAGE ONE, pink STAGE TWO. Every stage has one input only. Semantic reads and captures are separate; the script never repeats a click to make the pixels agree.

The first direct-window probe returned semantic STAGE ONE with yellow STAGE ZERO pixels. Direct get_window_state calls after pauses of 0, 250, 1000 and 3000 ms still showed the older image. After the second single click, semantics were STAGE TWO while the window image was green STAGE ONE. This bypasses our debug viewer and image handling.

In a second probe, a native CUA get_browser_state call with include_screenshot:true returned the correct page pixels. The next get_window_state then showed the current stage too. The fixture's double-requestAnimationFrame callback reached its server at that point. This is evidence about that sequence, not proof that a CDP screenshot is a reliable production fix or that occlusion is the only possible cause. No raw CDP or page-evaluation bridge was used.

The new repeat requested by the user behaved differently: both native window stages were already correct before the CUA page screenshot. All actual stage images were manually checked. Therefore the defect is intermittent or depends on window/rendering conditions; it does not occur on every launch. An identical PNG hash after an unchanged stage is normal and does not by itself mean a stale capture.

| Probe | Result |
| --- | --- |
| Direct window, 16 records | Semantics one stage ahead; repeated delayed window captures still old |
| Window/page comparison, 20 records | Old window frames; CUA page capture correct; following window capture current |
| Fresh repeat, 20 records | Correct window frames at both stages before page capture |

The failing window records, page/window comparison, successful repeat and selected actual PNGs are preserved separately in [the evidence directory](../evidence/cua-browser/): paint-window.json, paint-page-comparison.json and paint-repeat-correct.json. The repeat did not overwrite the failing run. Browser PID66036, owned Driver and profile entries were all absent after cleanup. No foreground change, existing document, personal profile or display capture was used.

## Same-window control with the human

The user then explicitly covered the newly opened test browser without minimizing it. Before input, the script paused for that confirmation. It used exactly one native browser_click, no candidate launch flags, no native page screenshot and no foreground command.

On the same PID45248/HWND5639126 and the same local page:

- While covered, semantic reads reported STAGE ONE. The actual window PNGs showed yellow STAGE ZERO, including the final capture after an additional3000ms pause. The stage's double-requestAnimationFrame callback had not reached the local server.
- The user uncovered the same window without another click and reported green STAGE ONE. A subsequent read-only observation returned green STAGE ONE too; the callback had now reached the server.
- The actual images and both human answers are preserved in paint-manual-background.json, paint-manual-human.json and the paint-manual-*.png files in the evidence directory.
- The browser, its Driver/profile and local server were closed. A read-only Windows check found owned PID absent, Driver0 and profile entries0.

This control links the failure to the covered-window condition in this run. It does not prove which Chromium/Windows component is responsible or that the proposed flags fix it. Those flags remain untested.

## First no-activation control

The user authorized raising the owned window without taking keyboard focus. The HWND_TOP + SWP_NOACTIVATE + SWP_NOMOVE + SWP_NOSIZE control used a new PID2380/HWND459140, one background click and no CUA page screenshot. Covered captures showed semantic STAGE ONE with yellow STAGE ZERO pixels.

SetWindowPos returned success. The immediate foreground HWND1446414 and keyboard-focus HWND461756 were unchanged, but the measured target Z-order rank was also unchanged at83. The first following PNG remained yellow STAGE ZERO. A later read found different foreground/focus handles; the script's focus assertion stopped the run and its finally closed the owned browser/server. That later foreground handle was no longer valid when checked, so its owner and the reason for the change are unknown. This is not proof of a no-focus solution or proof that the browser took focus. Evidence is preserved as paint-noactivate-inconclusive.json, paint-noactivate-human.json and two paint-noactivate-*.png images. Cleanup found PID absent, Driver0 and profile entries0.

The user then asked to try the Driver instead, and explicitly allowed keyboard-focus switching for that separate bring_to_front control. That permission does not authorize an automatic foreground fallback in production.

## Authorized Driver foreground control

The user explicitly allowed keyboard-focus switching for this test. A separate official0.33.1 run used PID10532/HWND10359628, the same fixture, one background browser_click, no candidate flags and no CUA page screenshot. The user confirmed the browser was covered without minimizing it.

- Before the raise, semantics were STAGE ONE while the actual window PNG remained yellow STAGE ZERO through the additional3000ms pause. Read-only foreground and keyboard-focus metadata belonged to Firefox PID7368/HWND918362. No Firefox document, screenshot or input was accessed.
- One public CUA bring_to_front on the exact owned PID/HWND reported raised:true and landed_on_target:true. Its previous foreground was0xe035a and new foreground0x9e134c, the owned browser window.
- Independent read-only Win32 metadata immediately and after every capture showed foreground and keyboard focus in Chrome PID10532/HWND10359628. Bounds did not change. Thus this route really took keyboard focus; it did not solve the no-activation requirement.
- The first window capture after the call, and captures after additional250/1000/3000ms pauses, showed green STAGE ONE. The user independently confirmed that the raised browser showed green STAGE ONE. There was no repeated page click.
- The final log contains25records, exactly1browser_click,1bring_to_front and0native page-screenshot requests. The browser, local fixture server, owned Driver and profile were cleaned up; Windows readback found PID absent, Driver0 and profile entries0.

Actual records, human permission/answers, cleanup and selected images are saved separately as paint-driver-front*.json/png in the evidence directory. This supports a foreground workaround for this one control, not a universal capture guarantee, not a flags fix and not permission to activate windows automatically in production. The native foreground helper performs both a z-order raise and activation, so this run does not isolate which step resumed painting.

## Reproduce

Run from this repository using the qualified Windows runtime:

```sh
node --experimental-transform-types scripts/probe-cua-paint.mjs
node --experimental-transform-types scripts/probe-cua-paint.mjs --compare-native-page
# Interactive controls; each requires its own explicit user permission:
node --experimental-transform-types scripts/probe-cua-paint.mjs --manual-background
node --experimental-transform-types scripts/probe-cua-paint.mjs --raise-noactivate
node --experimental-transform-types scripts/probe-cua-paint.mjs --driver-front
```

Each run uses a new owned browser, a local fixture and a timestamped ignored output directory. It records actual image bytes, SHA-256 hashes, semantic states, native calls and fixture callback times. It closes the owned browser and server. Read the PNGs: the completion message only means the script completed, not that pixels matched semantics or that the defect reproduced.

## Similar public reports

- [CUA issue 1620](https://github.com/trycua/cua/issues/1620) describes a background Windows Chromium launch with missing page accessibility and blank PrintWindow captures. The reporter attributes it to native window occlusion and reports success with three anti-throttling launch flags. It concerns launch_app, not our isolated browser_prepare route. The symptoms overlap but are not identical.
- [Chromium's native window occlusion documentation](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/docs/windows_native_window_occlusion_tracking.md) states that covered windows are treated like background tabs: rendering stops and JavaScript is throttled. This documents the mechanism, not the cause of our specific failure.
- [Codex Windows issue 42547](https://github.com/openai/codex/issues/42547) reports a correct CDP screenshot while PrintWindow shows a flat client surface. Disabling CalculateNativeWinOcclusion reportedly avoids the problem. Unlike our second probe, that reporter says Page.captureScreenshot did not recover the presented window. This supports distinguishing browser rendering from the Windows presented surface, not assuming a universal screenshot workaround.

## Options without patching the Driver

The user requested no-patch alternatives. No new run or configuration change was made for this research. None of these routes is a verified fix for our covered-window control yet.

1. **Launch flags through public CUA launch_app.** The qualified Windows API accepts additional_arguments. Its Chromium launch path already has the three anti-throttling flags discussed above. This can test the flags without Rust or a modified binary. However, launch_app is not browser_prepare's isolated_new ownership path. A new disposable user-data-dir, exact process/window identification, supported browser attachment and complete cleanup must be qualified; existing-profile attachment may need an explicit grant. Do not attach to a personal profile or silently bypass that boundary. Flags require a new browser launch, not a change to the already running window. The current browser_prepare interface exposes no extra-arguments option, and its source has no general launch-flags override.

2. **Official Chrome WindowOcclusionEnabled=false policy.** [Chromium's policy definition](https://raw.githubusercontent.com/chromium/chromium/main/components/policy/resources/templates/policy_definitions/Miscellaneous/WindowOcclusionEnabled.yaml) says disabling it prevents covered-window detection. It supports Windows Chrome90+, dynamic refresh and is explicitly not per-profile. This is a real preventive configuration option, but it affects the user's browser installation rather than only our disposable profile. Persistent policy changes need separate user approval; they are not a silent extension default. The older NativeWindowOcclusionEnabled policy is not the current setting.

3. **Public CUA page capture before window capture.** get_browser_state(include_screenshot:true) helped one earlier probe resume painting, after which the window PNG matched. It requires neither a patched Driver nor a separate browser engine. Test it under the same covered-window condition before considering it a workaround. It renews semantic snapshots and refs, so inserting it into image_only would break our current hint contract. Other public reports describe CDP capture failing or not recovering a window; this is not a guaranteed paint barrier.

4. **Keep the owned window uncovered.** Our human-controlled run recovered on uncover without another click. This is a demonstrated temporary operating condition, not a solution for background computer use. Automatically foregrounding windows would interrupt the user and is not approved as a hidden fallback.

The most targeted no-patch flag experiment is launch_app on one newly created disposable profile. Keeping the current ownership path unchanged instead favors testing native page capture first. Neither route has been selected or added to production. Changing capture APIs alone cannot be assumed to restore a renderer that stopped producing frames.

## Candidate patch and build boundary

Inspection of the exact 0.33.1 source and the owned Chrome process command line showed that isolated_browser_command omits these Windows flags:

```text
--disable-features=CalculateNativeWinOcclusion
--disable-backgrounding-occluded-windows
--disable-renderer-backgrounding
```

The Windows launch_app Chromium path already adds them. The proposed diagnostic patch adds the same three flags only to the isolated Windows launcher and extends its existing launch-argument test. It is prepared against tag cua-driver-rs-v0.33.1, commit a9baa8d107fba8b0aef5a4ed6233e498e88d14d0. The [candidate diff](cua-isolated-launch-flags.patch) is preserved for a separately approved build. It is not a verified fix.

The source pins Rust 1.97.1. Windows Rust/cargo and its MSVC target are absent on this machine. Visual Studio Build Tools 2022, the x86/x64 C++ component and Windows SDK10.0.26100.0 are present. WSL has only the Linux Rust target. No compilation was attempted and no compiler failure was observed. A future build needs the full source including sibling path dependencies, a matching Windows toolchain and Cargo dependencies. Downloading that toolchain is not currently authorized.
