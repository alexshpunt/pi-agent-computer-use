# Strict semantic window actions

`computer_act` accepts explicit `invoke`, `select` and `set_value` intents with a current hint or element token. They need the separately qualified Windows semantic runtime. Older runtimes refuse before dispatch. Ordinary `click` keeps its existing native action ladder.

- `invoke` calls the control's UIA Invoke pattern.
- `select` calls UIA SelectionItem.Select, not Ctrl+A or a pointer click.
- `set_value` takes `text` (up to 2000 characters) and calls Value.SetValue, or RangeValue.SetValue when Value is unavailable before the call. An empty string is allowed for a text value.

These actions accept no pixels, modifiers, foreground delivery or cursor animation. They are single actions, not sequence steps. UI-only observations are enough; pixel visibility is not a semantic prerequisite. A disabled control still refuses. Safe access, current observation, exact window lifetime and cancellation checks remain in force.

```js
// Save the window and chosen current hint from a real observation first.
try {
  text(await tools.computer_act({window_ref:load("window"),observation_id:load("observation"),
    action:"invoke",hint:load("control")}));
} finally {store("observation",null);store("control",null);}
```

The native tool admits one exact snapshot target and one UIA pattern. It has no mouse/key dispatch or foreground retry. Missing patterns, disabled/read-only controls and invalid range values refuse before the application call. Provider failure after a call starts is unknown; never repeat it blindly. Dispatch consumes the overview even on failure.

`delivered` means the UIA provider call completed. `action_capability.semantic` records the actual native pattern and explicitly leaves app effect and focus unverified. Read back the application state independently. No app-wide background guarantee follows from one successful control, and UIA providers may have their own focus behavior.

**Experimental: these actions can take foreground and keyboard focus.** The owner retained the explicit UIA functionality with this limit and returned LPT-626's no-focus goal to Ideas. All six current-desktop Chrome/Notepad actions changed the intended controls, but the controlled foreground/focus check failed. The corrected candidate was not repeated on another desktop after that failure. Do not use this route as a promise of non-interference with the human or another agent.

Windows build and application qualification are separate gates. No desktop lifecycle, general physical focus policy or concurrent-agent guarantee is added here.
The native UIA route uses the provider EnableWindow shield, not the pointer WS_EX_NOACTIVATE guard. Live checks must preserve the target's desktop membership as well as foreground/focus and app state. A focus-only measurement can miss a target moving to the current desktop.

Use `node scripts/check-semantic-artifact.mjs <artifact-directory> <exact-source-commit>` to check exact executable hashes and the advertised strict API without launching apps or sending input. It does not qualify app behavior. See [qualification results](semantic-actions-results.md).