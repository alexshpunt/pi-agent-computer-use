# Strict semantic window actions

See [the resource guide](computer-resources.md) for the current addresses, views and commands.

The driver takes explicit `invoke`, `select` and `set_value` intents with a current element token. On a native window, `computer_type` with `replace` sends `set_value`, and `computer_select` without `values` sends `select` to its target; both take a ref of the latest Read or a locator. No tool sends `invoke`: `computer_click` keeps the native click ladder. The bundled runtime supports these intents; an older runtime selected by override refuses before dispatch.

- `invoke` calls the control's UIA Invoke pattern.
- `select` calls UIA SelectionItem.Select, not Ctrl+A or a pointer click.
- `set_value` takes `text` (up to 2000 characters) and calls Value.SetValue, or RangeValue.SetValue when Value is unavailable before the call. An empty string is allowed for a text value.

These actions accept no pixels, modifiers or foreground delivery. UI-only observations are enough; pixel visibility is not a semantic prerequisite. A disabled control still refuses. Safe access, current observation, exact window lifetime and cancellation checks remain in force.

The native tool admits one exact snapshot target and one UIA pattern. It has no mouse/key dispatch or foreground retry. Missing patterns, disabled/read-only controls and invalid range values refuse before the application call. Provider failure after a call starts is unknown; never repeat it blindly. Dispatch consumes the overview even on failure.

`delivered` means the UIA provider call completed. `action_capability.semantic` records the actual native pattern and explicitly leaves app effect and focus unverified. Read back the application state independently. No app-wide background guarantee follows from one successful control, and UIA providers may have their own focus behavior.

**Focus and desktops.** A target on the current virtual desktop gets the WS_EX_NOACTIVATE guard for the call, so a provider that activates its window on Invoke (Chromium did) cannot take the foreground. A target on another desktop gets only the provider EnableWindow shield, because toggling that style there moved the window to the current desktop. In `test/live/semantic-focus.live.ts` (fork e6d26cb6, a disposable Windows Sandbox) a native Win32 target's invoke, select and set_value all landed while a 20 ms foreground sampler never saw the target; the previous runtime let the same target hold the foreground for about 0.8 s. Neither target left its desktop.

Limits from the same checks: many apps expose only their frame through UIA while on another desktop (Notepad, WinForms), so their content cannot be acted on there; Edge reports its page elements under another process, which the driver refuses before any call (`semantic_element_process_changed`). Browser pages belong to Playwright anyway. A passing app is not a guarantee for every UIA provider; read back the application state.
