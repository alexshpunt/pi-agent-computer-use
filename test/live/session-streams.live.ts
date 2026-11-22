import { readFile, writeFile } from "node:fs/promises";
import { afterAll, expect, test } from "vitest";
import { computerSource } from "../../src/computer-address.ts";
import { WINDOWS_POWERSHELL } from "../../src/runner.ts";
import { connectLive, openWindow, text, WINDOWS_POWERSHELL_PATH } from "./remote.ts";

// LPT-1701: window streams from isolated sessions to the host. Several sessions with animated windows stream through
// their hubs to a stand-in tile host on the same machine; it reports frame rate, size and the agent's activity, and
// the session's cua-spacesd and the hub's worker report their CPU. STREAM_SESSIONS, STREAM_WINDOWS (per session),
// STREAM_FPS and STREAM_SECONDS tune the run; STREAM_REPORT names a file for the full JSON report.
const live = await connectLive();
const SESSIONS = Number(process.env.STREAM_SESSIONS ?? 3), PER_SESSION = Number(process.env.STREAM_WINDOWS ?? 2);
const FPS = Number(process.env.STREAM_FPS ?? 10), SECONDS = Number(process.env.STREAM_SECONDS ?? 30);
// Smaller than the ticker's 480×320 window, including at 100% DPI.
const MAX_DIMENSION = 240;
const opened: string[] = [];
afterAll(async () => { for (const session of opened) await live.insert(session, { action: "close" }).catch(() => undefined); await live.close(); });

/** A window that repaints about 60 times a second: a counter and a sliding bar, so every frame differs. */
const ticker = (title: string) => ["-NoProfile", "-WindowStyle", "Hidden", "-EncodedCommand", Buffer.from(`Add-Type -AssemblyName System.Windows.Forms
$f = New-Object Windows.Forms.Form; $f.Text = '${title}'; $f.Width = 480; $f.Height = 320
$l = New-Object Windows.Forms.Label; $l.Left = 10; $l.Top = 10; $l.Width = 440; $l.Height = 60; $l.Font = New-Object Drawing.Font('Consolas', 28)
$p = New-Object Windows.Forms.Panel; $p.Top = 120; $p.Width = 60; $p.Height = 60; $p.BackColor = 'OrangeRed'
$f.Controls.AddRange(@($l, $p)); $w = [Diagnostics.Stopwatch]::StartNew()
$t = New-Object Windows.Forms.Timer; $t.Interval = 15
$t.Add_Tick({ $ms = $w.ElapsedMilliseconds; $l.Text = "$ms ms"; $p.Left = [int](($ms / 4) % 400) })
$t.Start(); [void]$f.ShowDialog()`, "utf16le").toString("base64")];

/** CPU seconds of each session's cua-spacesd and of the host's relay workers, which run the hubs. */
async function cpu(): Promise<{ spacesd: Record<string, number>; hubs: Record<string, number> }> {
  // Get-Process shows no CPU time for another user's process; WMI does.
  const spacesd = JSON.parse(await live.runner.run(WINDOWS_POWERSHELL, ["-NoProfile", "-Command",
    "@(Get-CimInstance Win32_Process | Where-Object Name -eq 'cua-spacesd.exe' | ForEach-Object { @{ id = $_.ProcessId; session = $_.SessionId; cpu = ($_.KernelModeTime + $_.UserModeTime) / 1e7 } }) | ConvertTo-Json -Compress"], { input: "" }) || "[]");
  const hubs = await live.runner.run("bash", ["-c", "for p in $(pgrep -f '[s]ession-relay-worker[.]ts'); do echo $p $(awk '{print $14+$15}' /proc/$p/stat) $(tr '\\0' ' ' < /proc/$p/cmdline); done"]);
  const ticks = Number(await live.runner.run("getconf", ["CLK_TCK"]));
  return {
    spacesd: Object.fromEntries([spacesd].flat().map((p: { session: number; cpu: number }) => [String(p.session), p.cpu])),
    hubs: Object.fromEntries(hubs.trim().split("\n").filter(Boolean).map(line => { const [pid, t] = line.split(" "); return [pid, Number(t) / ticks]; })),
  };
}

test("isolated sessions stream their windows to a tile host at the requested rate, with the agent's activity", { timeout: 900_000 }, async () => {
  const hubs: { session: string; url: string; token: string }[] = [];
  const windows: string[] = [];
  for (let s = 0; s < SESSIONS; s++) {
    const result = await live.insert(live.machine, { action: "open_session" });
    expect(result.details.status, text(result)).toBe("delivered");
    const session = computerSource("sandbox", result.details.sandbox_ref!);
    opened.push(session);
    const ref = result.details.sandbox_ref!;
    // Claim this test session before opening any windows. A desktop tile host also watches stream.json and
    // may request native size; the hub correctly uses the largest cap across viewers.
    const discovery = JSON.parse(await live.runner.run("bash", ["-c",
      'set -eu; set -- /mnt/c/Users/*/AppData/Local/PiComputerUse/sessions/"$1"/stream.json; test "$#" -eq 1; mv -- "$1" "$1.live-test"; cat -- "$1.live-test"',
      "session-streams.live.ts", ref]));
    expect(discovery).toMatchObject({ version: 1, session: ref, url: expect.stringMatching(/^ws:\/\/127\.0\.0\.1:\d+\/v1\/stream$/) });
    hubs.push({ session: ref, url: discovery.url, token: discovery.token });
    for (let w = 0; w < PER_SESSION; w++) windows.push(await openWindow(live, session, WINDOWS_POWERSHELL_PATH, ticker(`Ticker ${s}-${w}`), `Ticker ${s}-${w}`));
    if (s === 0) await openWindow(live, session, "C:\\Windows\\System32\\notepad.exe", [], "Notepad");
  }

  await live.runner.run("dd", ["status=none", "of=/tmp/pi-stream-probe.mjs"], { input: await readFile(new URL("./stream-probe.mjs", import.meta.url)) });
  const probe = live.runner.spawn("node", ["/tmp/pi-stream-probe.mjs"]);
  let output = "";
  probe.stdout.on("data", (chunk: Buffer) => { output += chunk; });
  probe.stderr.on("data", (chunk: Buffer) => process.stderr.write(chunk));
  const done = new Promise(resolve => probe.once("close", resolve));
  probe.stdin.end(JSON.stringify({ hubs, seconds: SECONDS, warmup: 5, maxFps: FPS, maxDimension: MAX_DIMENSION, include: "^(Ticker|.*Notepad)",
    record: { title: "Ticker 0-0", file: "/tmp/pi-stream-ticker.h264" } }));

  await new Promise(resolve => setTimeout(resolve, 5000));
  const before = await cpu();
  const startedAt = performance.now();
  // One agent action during the stream: its point must reach the tile host with the window it hit.
  const view = await live.read(windows[0], ["full"]);
  const clicked = await live.insert(`computer:observation/${view.details.observation_id}?hint=${encodeURIComponent((view.details.ui!.elements as { hint: string; role: string }[]).find(e => e.role === "Pane" || e.role === "Text")?.hint ?? "")}`, { action: "click" });
  expect(clicked.details.status, text(clicked)).toBe("delivered");
  await new Promise(resolve => setTimeout(resolve, Math.max(0, (SECONDS - 12) * 1000 - (performance.now() - startedAt))));
  const after = await cpu();
  const elapsed = (performance.now() - startedAt) / 1000;
  await done;
  const report = JSON.parse(output);

  const spacesdCpu = Object.fromEntries(Object.keys(after.spacesd).map(s => [s, +(((after.spacesd[s] - (before.spacesd[s] ?? 0)) / elapsed) * 100).toFixed(1)]));
  const hubCpu = Object.fromEntries(Object.keys(after.hubs).map(p => [p, +(((after.hubs[p] - (before.hubs[p] ?? 0)) / elapsed) * 100).toFixed(1)]));
  console.log(JSON.stringify({ fps: FPS, sessions: SESSIONS, seconds: report.seconds, spacesdCpuPercentOfCore: spacesdCpu, hubWorkerCpuPercentOfCore: hubCpu }, null, 1));
  if (process.env.STREAM_REPORT) await writeFile(process.env.STREAM_REPORT, JSON.stringify({ fps: FPS, sessions: SESSIONS, spacesdCpuPercentOfCore: spacesdCpu, hubWorkerCpuPercentOfCore: hubCpu, ...report }, null, 1));
  console.table(report.windows.map((w: Record<string, unknown>) => ({ session: w.session, title: w.title, size: `${w.width}x${w.height}`, fps: w.fps, kbps: w.kbps, keyframes: w.keyframes, gapP50: w.gapP50, gapP95: w.gapP95, firstFrameMs: w.firstFrameMs })));
  console.log("activity", JSON.stringify(report.activity.slice(-3)), "errors", JSON.stringify(report.errors), "recorded", report.recorded);

  expect(report.errors).toEqual([]);
  const tickers = report.windows.filter((w: { title: string }) => w.title.startsWith("Ticker"));
  expect(tickers).toHaveLength(SESSIONS * PER_SESSION);
  for (const w of tickers) {
    expect(w.negotiatedMaxDimension, w.title).toBe(MAX_DIMENSION);
    expect(w.firstFrameMs, w.title).toBeGreaterThanOrEqual(0);
    expect(w.maxFrameDimension, w.title).toBeLessThanOrEqual(MAX_DIMENSION);
    expect(Math.max(w.width, w.height), w.title).toBe(MAX_DIMENSION);
    expect(w.fps, w.title).toBeGreaterThanOrEqual(Math.min(5, FPS * 0.8));
  }
  const idle = report.windows.find((w: { title: string }) => /Notepad/.test(w.title));
  // An unchanged window still shows: its first frame is a keyframe, then it costs close to nothing.
  expect(idle.firstFrameMs, "the idle window's first frame").toBeGreaterThan(0);
  // Notepad's caret blink is its only change.
  expect(idle.kbps).toBeLessThan(64);
  // The click reaches the tile host as activity in the window it hit, with a point for the agent cursor.
  const clickedWindow = tickers.find((w: { title: string }) => w.title === "Ticker 0-0");
  expect(report.activity.some((a: { session: string; window: string | null; action?: string; point?: unknown }) =>
    a.action === "click" && a.point && `${a.session}/${a.window}` === clickedWindow.key), JSON.stringify(report.activity.slice(-3))).toBe(true);
});
