# CUA driver tool audit

Every tool advertised by the installed Windows runtime (CUA Driver 0.34.0, fork build `4379acbd`, 69 tools, plus `input_timeline` from the M7 fork build) and what this extension does with it. "Exposed" means reachable through ordinary IDE Read, Search, Write or Insert on `computer:` addresses; see [computer resources](../computer-resources.md).

## Exposed

| Tool | How it is reached |
| --- | --- |
| `list_apps`, `list_windows` | Search `computer:apps`, `computer:windows` or a machine/sandbox address |
| `launch_app` | Insert `open` |
| `get_window_state`, `zoom` | Window Read overviews and `region` detail |
| `get_window_status`, `restore_window` | `state` view and Insert `restore` |
| `get_window_control_state`, `manage_window` | `state` view and window-state Insert move/resize/minimize/maximize/focus |
| `list_displays`, `get_display_state`, `get_desktop_state` | Display discovery, display Read, virtual-desktop membership |
| `click`, `double_click`, `right_click`, `drag`, `scroll`, `scroll_at`, `move_pointer`, `type_text`, `press_key`, `hotkey`, `hold_keys`, `set_value`, `semantic_action` | Observation Insert actions, sequences and batches |
| `input_timeline` | Observation Insert `timeline` (M7) |
| `clipboard_read`, `clipboard_write` | Insert `clipboard_read` / `clipboard_write`, YOLO only (M7, LPT-816) |
| `invoke_menu` | Observation Insert `{"action":"menu","path":[...]}` (M7) |
| `kill_app` | Window Insert `kill`, only when every window of the process was opened by this session (M7) |
| `set_agent_cursor_motion`, `get_agent_cursor_state` | Opt-in reactive cursor animation |

## Covered another way

| Tool | Why it is not called |
| --- | --- |
| `verify_state` | `wait_for`/`verify` evaluate the same window and UI predicates in the adapter, with receipts and successor diffs |
| `bring_to_front`, `set_window_frame` | `manage_window` focus/move/resize with independent readback |
| `get_screen_size`, `get_accessibility_tree` | Display discovery and window discovery/overviews |
| `get_cursor_position`, `move_cursor` | Agent coordinates are window-local overview pixels; pointer receipts report the real pointer |
| `start_recording`, `stop_recording`, `get_recording_state`, `install_ffmpeg` | Handled by the recording task (LPT-817) |

## Rejected

| Tool | Reason |
| --- | --- |
| `page`, `get_browser_state`, `browser_prepare`, `browser_navigate`, `browser_click`, `browser_type`, `browser_dialog`, `browser_set_input_files`, `browser_download`, `browser_pointer` | Playwright owns web pages in session-opened browsers; no CUA browser fallback and no attachment to personal browsers |
| `replay_trajectory` | Replays recorded raw coordinates without a fresh observation, so input would not be grounded in what the window shows now |
| `get_config`, `set_config` | Persistent driver configuration is machine setup; per-call options carry what the adapter needs |
| `check_for_update`, `install_extension` | No automatic updates or extension installs; runtimes are pinned and qualified explicitly |
| `parse_visual_regions` | Needs the perception extension and its signed catalog, which is not installed; Windows OCR (`ocr` view) covers text |
| `start_session`, `get_session`, `list_sessions`, `get_session_state`, `end_session`, `escalate_session` | One computer session owns one driver connection; its implicit lifecycle session is enough |
| `set_agent_cursor_enabled`, `set_agent_cursor_theme` | The human-facing overlay is separate work (Qt overlay research) |
| `check_permissions`, `health_report`, `debug_window_info` | Diagnostics only; startup checks verify the pinned runtime and its tools |
