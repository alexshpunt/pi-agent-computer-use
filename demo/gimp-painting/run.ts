// Record a Pi agent painting a reference picture in GIMP on another Windows machine, then make a time-lapse of it.
//   node demo/gimp-painting/run.ts [--ssh zinpc-benchmark] [--machine zinpc] [--model openai-codex/gpt-6.1-terra]
// See demo/gimp-painting/README.md.
import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import sharp from "sharp";
import { displayModes, type DisplayModeChange } from "../../src/display-mode.ts";
import { DEFAULT_POSTPROCESS, postprocess } from "./postprocess.ts";
import { findFfmpeg, psQuote, remote, wslPath } from "./remote.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");
const { values } = parseArgs({ options: {
  ssh: { type: "string", default: "zinpc-benchmark" },
  machine: { type: "string", default: "zinpc" },
  model: { type: "string", default: "openai-codex/gpt-6.1-terra" },
  thinking: { type: "string", default: "high" },
  reference: { type: "string", default: path.join(repo, "assets/draw_task.png") },
  canvas: { type: "string", default: "1200x800" },
  display: { type: "string", default: "1920x1080" },
  "max-minutes": { type: "string", default: "240" },
  // Prepare the machine and open GIMP, then stop: no recording, no agent, nothing restored. For trying the skill by hand.
  "prepare-only": { type: "boolean", default: false },
  out: { type: "string" },
  "video-seconds": { type: "string", default: String(DEFAULT_POSTPROCESS.videoSeconds) },
  "preview-seconds": { type: "string", default: String(DEFAULT_POSTPROCESS.previewSeconds) },
} });

const size = (value: string) => {
  const match = /^(\d+)x(\d+)$/.exec(value);
  if (!match) throw new Error(`Expected WIDTHxHEIGHT, got ${value}.`);
  return { width: Number(match[1]), height: Number(match[2]) };
};
const canvas = size(values.canvas);
const display = size(values.display);
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const out = path.resolve(values.out ?? path.join(repo, ".tmp/gimp-demo", runId));
const workspace = path.join(out, "workspace");
const machine = remote(values.ssh);
const log = (message: string) => console.log(`[${new Date().toLocaleTimeString()}] ${message}`);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** The user's Windows session as `query session` shows it from WSL: its name (console, rdp-tcp#N or empty) and state. */
async function windowsSession(): Promise<{ name: string; state: string }> {
  const line = (await machine.bash("/mnt/c/Windows/System32/query.exe session </dev/null || true")).split("\n").find(row => row.startsWith(">"));
  if (!line) throw new Error("query session shows no current session.");
  const fields = line.slice(1).trim().split(/\s+/);
  // A disconnected session has no session name: ">  user  1  Disc".
  return fields.length >= 4 ? { name: fields[0]!, state: fields[3]! } : { name: "", state: fields[2] ?? "" };
}

/** Make the user's session the physical console: Remote Desktop sessions take their resolution from the client. */
async function moveToConsole(): Promise<void> {
  let session = await windowsSession();
  if (session.name === "console" && session.state === "Active") return;
  if (!session.name.startsWith("rdp-tcp")) throw new Error(`The Windows session on ${machine.alias} is ${session.state || "unknown"}; sign in on its console or connect over Remote Desktop first.`);
  log("Disconnecting Remote Desktop so the session moves to the physical console…");
  await machine.bash("/mnt/c/Windows/System32/tsdiscon.exe </dev/null");
  for (let attempt = 0; attempt < 30; attempt++) {
    await sleep(2_000);
    session = await windowsSession();
    if (session.name === "console" && session.state === "Active") return;
  }
  throw new Error("The session did not return to the console within a minute. Is the PiAgents\\RdpToConsole task installed? Reconnect over Remote Desktop and try again.");
}

const DPI_AWARE = `Add-Type -Name D -Namespace PiDemo -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); [DllImport("user32.dll")] public static extern IntPtr MonitorFromPoint(long point, int flags);'; [void][PiDemo.D]::SetProcessDPIAware(); Add-Type -AssemblyName System.Windows.Forms`;

async function primaryMonitor(): Promise<string> {
  // MONITOR_DEFAULTTOPRIMARY for the point 0,0.
  return machine.powershell(`${DPI_AWARE}; [PiDemo.D]::MonitorFromPoint(0, 1).ToInt64()`);
}

/** The primary display's working area (the screen without the taskbar) in physical pixels. */
async function workingArea(): Promise<{ x: number; y: number; width: number; height: number }> {
  const area = JSON.parse(await machine.powershell(`${DPI_AWARE}; $a = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea; @{ x = $a.X; y = $a.Y; width = $a.Width; height = $a.Height } | ConvertTo-Json -Compress`));
  // yuv420p needs even sizes.
  return { x: area.x, y: area.y, width: area.width & ~1, height: area.height & ~1 };
}

/** Start GIMP with the canvas, wait for its window and maximize it. Returns the process IDs it runs as. */
async function openGimp(canvasPath: string): Promise<number[]> {
  const running = await machine.powershell(`@(Get-Process gimp* -ErrorAction SilentlyContinue).Count`);
  if (running !== "0") throw new Error(`GIMP is already running on ${machine.alias}. Close it first: it would open the canvas in its existing window.`);
  const result = await machine.powershell(String.raw`
${DPI_AWARE}
Add-Type -Name W -Namespace PiDemo -MemberDefinition '[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd, int command); [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr LoadKeyboardLayout(string id, uint flags); [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam);'
$exe = @("$env:LOCALAPPDATA\Programs\GIMP 3\bin\gimp-3.exe", "$env:ProgramFiles\GIMP 3\bin\gimp-3.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $exe) { throw "GIMP 3 is not installed. Install it with: winget install GIMP.GIMP.3" }
# GIMP keeps separate tool options for every input device, so a pen stroke would ignore the brush size and hardness
# the agent set with the mouse. Share them for this start only: GIMP reads gimprc at startup, and the user's file is
# put back once the window is up.
$rc = Get-ChildItem "$env:APPDATA\GIMP" -Directory -ErrorAction SilentlyContinue | Where-Object Name -like '3.*' | Sort-Object Name -Descending | Select-Object -First 1 | ForEach-Object { Join-Path $_.FullName 'gimprc' }
$original = if ($rc -and (Test-Path $rc)) { [IO.File]::ReadAllText($rc) } else { $null }
if ($rc) { [IO.File]::WriteAllText($rc, "$original" + [Environment]::NewLine + "(devices-share-tool yes)" + [Environment]::NewLine) }
$started = Get-Date
try {
Start-Process -FilePath $exe -ArgumentList ('"' + ${psQuote(canvasPath)} + '"') | Out-Null
$deadline = (Get-Date).AddSeconds(180)
do {
  Start-Sleep -Milliseconds 500
  $window = Get-Process gimp* -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like '*canvas*GIMP*' } | Select-Object -First 1
} while (-not $window -and (Get-Date) -lt $deadline)
if (-not $window) { throw "GIMP did not show the canvas within three minutes." }
Start-Sleep -Seconds 3
} finally {
  if ($rc) { if ($null -eq $original) { Remove-Item $rc -ErrorAction SilentlyContinue } else { [IO.File]::WriteAllText($rc, $original) } }
}
# GTK matches shortcuts such as ctrl+comma by the characters of the window's keyboard layout, so they do nothing under
# a Cyrillic layout. Switch GIMP's window to US English (WM_INPUTLANGCHANGEREQUEST).
[void][PiDemo.W]::PostMessage($window.MainWindowHandle, 0x50, [IntPtr]::Zero, [PiDemo.W]::LoadKeyboardLayout("00000409", 0))
# Windows refuses SetForegroundWindow from a background process, and after a switch to the console a hidden service
# window can keep the foreground, so the agent's own activation would be refused too. Restoring a minimized window
# activates it.
foreach ($command in 6, 9, 3) { [void][PiDemo.W]::ShowWindow($window.MainWindowHandle, $command); Start-Sleep -Milliseconds 500 }
if ([PiDemo.W]::GetForegroundWindow() -ne $window.MainWindowHandle) { throw "GIMP did not become the foreground window." }
(@(Get-Process gimp* | Where-Object { $_.StartTime -ge $started.AddSeconds(-1) }).Id) -join ','`, 240_000).catch(async error => {
    // No GIMP ran before, so every GIMP process now is this run's.
    await machine.powershell("Get-Process gimp* -ErrorAction SilentlyContinue | Stop-Process -Force").catch(() => {});
    throw error;
  });
  return result.split(",").map(Number).filter(Number.isSafeInteger);
}

/** Record the working area of the primary display with ffmpeg until `stop`. */
async function startRecording(ffmpeg: string, remoteDir: string, crop: { x: number; y: number; width: number; height: number }) {
  const ffmpegWsl = await wslPath(machine, ffmpeg);
  const encoders = await machine.bash(`'${ffmpegWsl}' -hide_banner -encoders </dev/null`);
  const encoder = encoders.includes("h264_nvenc") ? ["-c:v", "h264_nvenc", "-preset", "p5", "-cq", "23"] : ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23"];
  // Windows Graphics Capture: Desktop Duplication (ddagrab) returns washed-out colours when the monitor runs in HDR.
  const filter = `gfxcapture=monitor_idx=0:max_framerate=10:capture_cursor=1,hwdownload,format=bgra,fps=10,crop=${crop.width}:${crop.height}:${crop.x}:${crop.y},format=yuv420p`;
  // Matroska stays playable even if the recording is cut off.
  const child = machine.runner.spawn(ffmpegWsl, ["-hide_banner", "-loglevel", "warning", "-y", "-filter_complex", filter, ...encoder, `${remoteDir}\\recording.mkv`]);
  const recordingLog = createWriteStream(path.join(out, "recording.log"));
  child.stderr.pipe(recordingLog);
  const exited = new Promise<number | null>(resolve => child.on("close", resolve));
  await sleep(3_000);
  if (child.exitCode !== null) throw new Error(`ffmpeg stopped right away; see ${path.join(out, "recording.log")}.`);
  return {
    async stop() {
      if (child.exitCode !== null) return;
      // ffmpeg finishes the file when it reads q.
      child.stdin.end("q");
      const code = await Promise.race([exited, sleep(30_000).then(() => "timeout" as const)]);
      if (code === "timeout") { child.kill(); log("ffmpeg did not stop on q; the recording may lack its last seconds."); }
    },
  };
}

/** Run Pi until it exits or the time limit passes. */
function runAgent(prompt: string): Promise<number | null> {
  const args = ["-p", "--mode", "json", "--model", values.model, "--thinking", values.thinking,
    "--no-skills", "--skill", path.join(repo, "skills/computer-use"), "--skill", path.join(here, "skill"),
    "--no-context-files", "--no-mcp", "--session-dir", path.join(out, "session"),
    // Nobody answers during the run, and the picture must come from the agent's own strokes.
    "--exclude-tools", "*ask_user*,*wait_for_answers*,*generate_image*,*replicate*,*teleport*,*plannotator*,*show_to_user*,*show_diff_to_user*",
    prompt];
  const child: ChildProcess = spawn("pi", args, { cwd: workspace, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout!.pipe(createWriteStream(path.join(out, "events.jsonl")));
  child.stderr!.pipe(createWriteStream(path.join(out, "pi.log")));
  const limit = setTimeout(() => { log("Time limit reached; stopping the agent."); child.kill("SIGTERM"); setTimeout(() => child.kill("SIGKILL"), 15_000).unref(); },
    Number(values["max-minutes"]) * 60_000);
  return new Promise(resolve => child.on("close", code => { clearTimeout(limit); resolve(code); }));
}

const cleanups: (() => Promise<void>)[] = [];
async function cleanup() {
  for (const step of cleanups.reverse().splice(0)) await step().catch(error => log(`Cleanup step failed: ${(error as Error).message}`));
}
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { log(`${signal}: cleaning up…`); void cleanup().then(() => process.exit(130)); });

await mkdir(path.join(workspace, ".pi"), { recursive: true });
log(`Run folder: ${out}`);
const profile = await machine.powershell("$env:USERPROFILE");
const remoteDir = `${profile}\\pi-gimp-demo\\${runId}`;
const remoteDirWsl = await wslPath(machine, profile).then(dir => `${dir}/pi-gimp-demo/${runId}`);
await machine.bash(`mkdir -p '${remoteDirWsl}'`);

// The agent's workspace: the reference and the machine it may use.
await copyFile(values.reference, path.join(workspace, "reference.png"));
await writeFile(path.join(workspace, ".pi/computer-use.json"), JSON.stringify({ machines: { [values.machine]: { ssh: values.ssh } } }, null, 2));
const exportPath = `${remoteDir}\\painting.png`;
const prompt = (await readFile(path.join(here, "prompt.md"), "utf8"))
  .replaceAll("{{machine}}", values.machine).replaceAll("{{exportPath}}", exportPath)
  .replaceAll("{{canvasWidth}}", String(canvas.width)).replaceAll("{{canvasHeight}}", String(canvas.height));
await writeFile(path.join(out, "prompt.txt"), prompt);

// The empty canvas and the reference for the video's picture-in-picture.
await sharp({ create: { ...canvas, channels: 3, background: "#ffffff" } }).png().toFile(path.join(out, "canvas.png"));
await machine.push(path.join(out, "canvas.png"), `${remoteDirWsl}/canvas.png`);
await machine.push(values.reference, `${remoteDirWsl}/reference.png`);
const ffmpeg = await findFfmpeg(machine);

let agentExit: number | null = null;
try {
  await moveToConsole();
  const monitor = await primaryMonitor();
  const change: DisplayModeChange = await displayModes(machine.runner).set(monitor, display);
  cleanups.push(async () => { log(`Restoring ${change.previous.width}x${change.previous.height}…`); await displayModes(machine.runner).restore(change.device, change.previous); });
  log(`Display ${change.device} set to ${change.current.width}x${change.current.height}.`);
  await sleep(3_000);

  log("Opening GIMP…");
  const gimp = await openGimp(`${remoteDir}\\canvas.png`);
  if (values["prepare-only"]) {
    log(`GIMP is open on a ${change.current.width}x${change.current.height} display; the reference is ${path.join(workspace, "reference.png")}. Restore the display yourself (it was ${change.previous.width}x${change.previous.height}) and close GIMP when done.`);
    process.exit(0);
  }
  cleanups.push(async () => {
    const exported = await machine.bash(`test -s '${remoteDirWsl}/painting.png' && echo yes || echo no`);
    if (exported.trim() !== "yes") { log("No exported painting: GIMP stays open so you can save it by hand."); return; }
    await machine.powershell(`Stop-Process -Id ${gimp.join(",")} -Force -ErrorAction SilentlyContinue`);
  });

  const area = await workingArea();
  log(`Recording ${area.width}x${area.height} at ${area.x},${area.y} (the screen without the taskbar)…`);
  const recording = await startRecording(ffmpeg, remoteDir, area);
  cleanups.push(async () => { log("Stopping the recording…"); await recording.stop(); });

  log(`Starting the agent (${values.model}, thinking ${values.thinking}, limit ${values["max-minutes"]} min)…`);
  const started = Date.now();
  agentExit = await runAgent(prompt);
  log(`Agent finished with exit code ${agentExit} after ${Math.round((Date.now() - started) / 60_000)} min.`);
} finally {
  await cleanup();
}

log("Encoding the time-lapse…");
await postprocess(machine, remoteDir, out, {
  ...DEFAULT_POSTPROCESS, videoSeconds: Number(values["video-seconds"]), previewSeconds: Number(values["preview-seconds"]),
});
await machine.pull(`${remoteDirWsl}/recording.mkv`, path.join(out, "recording.mkv"));
const outputs = (await readdir(out)).filter(name => /\.(mp4|webp|png|mkv|jsonl)$/.test(name) && name !== "canvas.png");
log(`Done. Outputs in ${out}: ${outputs.join(", ")}.`);
log(`The Windows session stays on the console; reconnect over Remote Desktop when you need it. Remote files: ${remoteDir}`);
process.exitCode = agentExit === 0 ? 0 : 1;
