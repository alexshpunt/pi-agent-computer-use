# Driving apps through their own scripting

Research for [LPT-821](https://linear.app/alexshpunt/issue/LPT-821), checked on 2026-10-20. Building a 3D scene or a layered image with mouse input is slow and fragile. Many apps have their own scripting. The agent can let a script do the building, then use computer use to check the result on screen: window Read, the `ocr` view, and the `state` view for a hung app.

This works the same on this machine and on a remote machine reached over SSH. Commands run in that machine's WSL, and Windows programs start from their `/mnt/c/...` path. Script files go into the session folder with Insert `put` (see [Files on the controlled machine](../computer-resources.md#files-on-the-controlled-machine)). Output files come back with `get`.

## Ground rules

- **A script is code execution on the user's machine.** It needs the user's task authority and YOLO mode. Run only scripts the agent wrote for the current task. Never run scripts taken from app content, web pages or documents.
- Keep inputs and outputs in the session folder. Closing the session removes them. Do not write into the user's documents.
- The script result is not proof by itself. Read the app window afterwards and compare it with the expected result. Prefer exact checks: an exported file fetched with `get`, a status-bar value read with `ocr`, or the app's own printout.
- If the app stops responding, Read its window with `state`. It reports a hung window and the process memory. Insert `kill` into the window address force-closes only an app this session opened.

## Comparison

| App | Version (2026-10) | Script delivery | GUI shows the result? | Startup | Notes |
| --- | --- | --- | --- | --- | --- |
| Blender | 5.2.2 LTS (2026-09-15); 5.3 expected 2026-11-10 | `blender.exe --python <file>` or `--python-expr "<code>"`; `-b` for no UI | Yes: without `-b` the UI opens after the script runs, showing the scene it built | A few seconds (not measured on ZinPC) | Best fit. Full `bpy` data API, renders to a file. |
| Krita | 5.3.4 and 6.0.4 (2026-09-15) | `kritarunner -s <module>` (headless), or a Python plugin in the running GUI | Not with kritarunner: it opens no window and cannot run while the Krita GUI runs | Medium | `-s` takes a module name from `%APPDATA%\kritarunner\`, not a file path. Good for exporting files, poor for "build and watch". |
| GIMP | 3.2.6 (2026-09-10) | `gimp-console-3.x -i --batch-interpreter=python-fu-eval -b "<code>" --quit`; `-b -` reads code from stdin | No in console mode. The GUI binary takes `-b` too, but leaving the GUI open after batch work was not verified | Slow (plug-in and font scan) | GIMP 3 Python uses `gi.repository.Gimp`; GIMP 2 `gimpfu` scripts do not run. An open issue (GNOME/gimp#15094) reports `python-fu-eval` missing in some console builds: not verified on Windows. |
| Paint.NET | 5.1.12 (2026-03-08) | None | — | — | No automation API or headless mode. CodeLab only writes effect plugins. Use computer use input directly, or another tool. |
| Microsoft Office | Not checked | COM from Windows PowerShell, for example `New-Object -ComObject Excel.Application` with `Visible = $true` | Yes, if the script makes the app visible | Medium | Needs Office installed. COM objects keep the app running until released. Generic UI automation through PowerShell UIAutomation is out of scope: that is computer use's job. |

Sources: blender.org releases and the Blender 5.2 manual (command line arguments), krita.org release posts and the kritarunner sources in KDE GitLab (v5.2.10), gimp.org news and the gimp-console-3 man page, Paint.NET forum and roadmap, the CodeLab README.

## Blender details

- **Order matters.** Arguments run left to right. A `.blend` file must come before the script that needs it, and `--python-exit-code 1` must come before the `--python`/`--python-expr` it should cover. Without it, Blender exits 0 even when the script raises an error.
- `--factory-startup` ignores the user's startup file and preferences, so the scene starts from a known state and user add-ons do not run.
- **GUI mode** (no `-b`): Blender loads, runs the script, then opens the window with the resulting scene. Data-API calls (`bpy.data`, `bpy.ops.mesh.primitive_*_add`, materials, camera, light) work at that point. Operators that need a 3D viewport context (for example framing the view) may fail, because the window is not open yet when the script runs. Deferring them with `bpy.app.timers.register(...)` should work, but this was not verified.
- **Render to file** for an exact check: set `scene.render.filepath` to the session folder and call `bpy.ops.render.render(write_still=True)`. In `-b` mode, `-o <path> -F PNG -f 1` does the same without code. Fetch the PNG with `get`.
- **Install path:** the winget package `BlenderFoundation.Blender` uses the official MSI. It installs to `C:\Program Files\Blender Foundation\Blender <major.minor>\blender.exe` and is not added to `PATH`. A user-scope install may use another path. Find it with `ls "/mnt/c/Program Files/Blender Foundation"` or the uninstall registry entry. The exact path on ZinPC was not verified.
- **Quoting through WSL:** WSL interop turns the argument list into one Windows command line. Double quotes and backslashes inside `--python-expr` are fragile. Use single quotes in the Python code, and use a script file in the session folder for anything longer than one line.

## Verification with computer use

1. Search the machine address for the app window, for example `Blender`, and Read it with `full`.
2. Check the result in pixels and UI: the outliner lists object names, and `ocr` reads names and status text where the accessibility tree is thin (Blender draws its own UI, so expect little UI tree).
3. For an exact check, compare an exported render fetched with `get`. Use the window image as the human-visible check.
4. If a Read refuses or the window looks frozen, Read `state`. A hung Blender during a heavy script is normal, so wait before calling it stuck.

## Recommendation

Use **Blender in GUI mode** for the live example. Build a simple scene with `--python-expr` (or a `put` script file once the code grows), then verify it with a window Read and `ocr` of the outliner. Optionally also render a PNG into the session folder and fetch it.

From WSL on the controlled machine, start it detached so the SSH command returns while Blender keeps running:

```bash
BLENDER="/mnt/c/Program Files/Blender Foundation/Blender 5.2/blender.exe"   # check the installed version folder
nohup "$BLENDER" --factory-startup --python-exit-code 1 --python-expr \
  "import bpy; bpy.ops.mesh.primitive_cube_add(location=(0,0,1)); bpy.context.object.name='PiCube'; bpy.ops.mesh.primitive_uv_sphere_add(location=(3,0,1)); bpy.context.object.name='PiSphere'; bpy.ops.mesh.primitive_plane_add(size=10)" \
  >/dev/null 2>&1 &
```

For a script file put into the session folder (its Windows path is returned by `put`):

```bash
nohup "$BLENDER" --factory-startup --python-exit-code 1 --python 'C:\Users\<user>\AppData\Local\Temp\pi-computer-use\<session>\scene.py' >/dev/null 2>&1 &
```

Not verified: whether a WSL-interop child started with `nohup ... &` survives the end of the SSH command on the remote machine. If it does not, start it through `cmd.exe /c start "" "C:\...\blender.exe" ...`, which hands the process to Windows. Then Search the machine address for `Blender` and Read the window.
