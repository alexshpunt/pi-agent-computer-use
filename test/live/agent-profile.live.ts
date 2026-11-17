import { afterAll, beforeAll, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { powershellOf, runPowerShell } from "../../src/runner.ts";
import { connectLive, serveFixture, text } from "./remote.ts";
import type { ComputerResult } from "../../src/session.ts";

// LPT-820: the agent's persistent Chrome profile keeps site data between computer sessions; a disposable one does not.
const host = await connectLive();
const fixture = await serveFixture(host.runner);
const quote = (value: string) => "'" + value.replaceAll("'", "''") + "'";
const originalEnvironment = { LOCALAPPDATA: process.env.LOCALAPPDATA, WSLENV: process.env.WSLENV };
let isolated: { root: string; chrome: string } | undefined;

// Only this local test worker gets a fresh app-data home. Other desktop suites still use their installed tools.
// Remote machine workers do not inherit the caller's environment and retain their existing setup.
beforeAll(async () => {
  if (process.env.LIVE_MACHINE !== "local") return;
  const paths = JSON.parse(await runPowerShell(host.runner, powershellOf(host.runner),
    "@{ local = $env:LOCALAPPDATA; temp = $env:TEMP } | ConvertTo-Json -Compress")) as { local: string; temp: string };
  const root = paths.temp + "\\pi-live-agent-profile-" + randomUUID();
  await runPowerShell(host.runner, powershellOf(host.runner), `New-Item -ItemType Directory -Path ${quote(root)} | Out-Null`);
  isolated = { root, chrome: paths.local + "\\Google\\Chrome\\Application" };
  const link = isolated.root + "\\Google\\Chrome\\Application";
  await runPowerShell(host.runner, powershellOf(host.runner), `
if (Test-Path -LiteralPath ${quote(isolated.chrome)} -PathType Container) {
  New-Item -ItemType Directory -Force -Path ${quote(isolated.root + "\\Google\\Chrome")} | Out-Null
  New-Item -ItemType Junction -Path ${quote(link)} -Target ${quote(isolated.chrome)} | Out-Null
}`);
  process.env.LOCALAPPDATA = isolated.root;
  process.env.WSLENV = [...(originalEnvironment.WSLENV ?? "").split(":")
    .filter(entry => entry && entry.split("/")[0].toUpperCase() !== "LOCALAPPDATA"), "LOCALAPPDATA"].join(":");
});

afterAll(async () => {
  for (const [key, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  fixture.close();
  if (!isolated) return;
  // Remove the program junction non-recursively before deleting only our temporary profile tree.
  await runPowerShell(host.runner, powershellOf(host.runner), `
$link = ${quote(isolated.root + "\\Google\\Chrome\\Application")}
if (Test-Path -LiteralPath $link) {
  $entry = Get-Item -LiteralPath $link -Force
  if ($entry.LinkType -ne 'Junction' -or @($entry.Target)[0] -ne ${quote(isolated.chrome)}) { throw 'Unexpected browser fixture link' }
  $entry.Delete()
}
Remove-Item -LiteralPath ${quote(isolated.root)} -Recurse -Force`);
});

const close = async (...sessions: Awaited<ReturnType<typeof connectLive>>[]) => {
  const results = await Promise.allSettled(sessions.map(session => session.close()));
  for (const result of results) {
    if (result.status === "rejected") throw result.reason;
    expect(result.value.details.status, text(result.value)).toBe("closed");
  }
};

// Hold the owned process handle before cleanup so a fast exit cannot hide forced termination.
const observeBrowserExit = async (live: Awaited<ReturnType<typeof connectLive>>, pid: number) => {
  const observer = live.runner.spawn(powershellOf(live.runner), ["-NoProfile", "-NonInteractive", "-Command",
    `$ErrorActionPreference='Stop'; $p=[Diagnostics.Process]::GetProcessById(${pid}); $handle=$p.Handle;
[Console]::WriteLine('ready');
if (-not $p.WaitForExit(15000)) { throw 'Owned browser did not exit' }
[Console]::WriteLine('exit='+$p.ExitCode)`]);
  let output = "", errors = "";
  let ready!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; });
  observer.stdout.on("data", chunk => { output += chunk.toString(); if (output.includes("ready")) ready(); });
  observer.stderr.on("data", chunk => { errors += chunk.toString(); });
  const ended = once(observer, "exit");
  await Promise.race([started, ended.then(() => { throw Error(`Browser exit observer failed: ${errors}`); })]);
  return async () => {
    const [code] = await ended;
    expect(code, errors).toBe(0);
    const browserExit = output.match(/(?:^|\n)exit=(-?\d+)/);
    expect(browserExit, output).not.toBeNull();
    expect(Number(browserExit![1])).toBe(0);
  };
};
const evaluate = async (live: Awaited<ReturnType<typeof connectLive>>, opened: ComputerResult, expression: string) => {
  const dom = await live.read(`computer:window/${opened.details.window_ref}`, ["dom"]);
  const result = await live.insert(`computer:observation/${dom.details.observation_id}`, { action: "evaluate", expression });
  expect(result.details.status, text(result)).toBe("delivered");
  expect(result.details.dom?.evaluation?.error).toBeUndefined();
  return result.details.dom?.evaluation?.value;
};

test("an already-running agent profile is refused before Chromium is launched", async () => {
  const first = await connectLive();
  const second = await connectLive();
  try {
    const opened = await first.insert(first.machine, { action: "open_browser", browser: "msedge", profile: "agent", url: `${fixture.base}/` });
    expect(opened.details.status, text(opened)).toBe("observed");
    const duplicate = await second.insert(second.machine, { action: "open_browser", browser: "msedge", profile: "agent", url: `${fixture.base}/other` });
    expect(duplicate.details.status).toBe("refused");
    expect(duplicate.details.state).toMatchObject({ operation: "open_browser", code: "agent_profile_in_use" });
    expect(await evaluate(first, opened, "location.pathname")).not.toContain("/other");
  } finally { await close(second, first); }
});
test("agent Chromium uses a normal browser debugging connection", async () => {
  const live = await connectLive();
  try {
    const opened = await live.insert(live.machine, { action: "open_browser", browser: "msedge", profile: "agent", url: `${fixture.base}/` });
    expect(opened.details.status, text(opened)).toBe("observed");
    const pid = opened.details.target!.pid;
    const command = await live.powershell(`(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`);
    expect(command).toMatch(/--remote-debugging-port=[1-9]\d*/);
    if (isolated) expect(command).toContain(isolated.root + "\\PiComputerUse\\browser-profiles\\msedge");
    expect(command).not.toContain("--remote-debugging-pipe");
    expect(await evaluate(live, opened, "String(navigator.webdriver)")).toContain("false");
  } finally { await close(live); }
});
test("Safe opens and cleanly closes its agent browser without a debugging endpoint", async () => {
  const live = await connectLive(process.cwd(), "safe");
  let exited: (() => Promise<void>) | undefined;
  try {
    const before = (await fixture.journal()).filter(entry => entry.type === "download-served").length;
    const url = `${fixture.base}/download/report.txt`;
    const opened = await live.insert(live.machine, { action: "open_browser", browser: "msedge", profile: "agent", url });
    expect(opened.details.status, text(opened)).toBe("observed");
    const pid = opened.details.target!.pid;
    const command = await live.powershell("(Get-CimInstance Win32_Process -Filter \"ProcessId=" + pid + "\").CommandLine");
    expect(command).not.toContain(url);
    expect((await fixture.journal()).filter(entry => entry.type === "download-served")).toHaveLength(before);
    expect(command).not.toMatch(/--remote-debugging-(port|pipe)/);
    const dom = await live.read("computer:window/" + opened.details.window_ref, ["dom"]);
    expect(dom.details.status).toBe("refused");
    const image = await live.read("computer:window/" + opened.details.window_ref, ["image"]);
    expect(image.details.status, text(image)).toBe("observed");
    const click = await live.insert(`computer:observation/${image.details.observation_id}`, { action: "click", x: 10, y: 10 });
    expect(click.details.status).toBe("refused");
    exited = await observeBrowserExit(live, pid);
  } finally {
    try { await close(live); } finally { await exited?.(); }
  }
});
test("agent Chromium retains site data after its browser closes", async () => {
  const marker = `pi-${Date.now()}`;
  const first = await connectLive();
  try {
    const opened = await first.insert(first.machine, { action: "open_browser", browser: "msedge", profile: "agent", url: `${fixture.base}/` });
    expect(opened.details.status, text(opened)).toBe("observed");
    expect(await evaluate(first, opened, `localStorage.setItem("pi-marker", "${marker}"), localStorage.getItem("pi-marker")`)).toContain(marker);
  } finally { await close(first); }
  const second = await connectLive();
  try {
    const opened = await second.insert(second.machine, { action: "open_browser", browser: "msedge", profile: "agent", url: `${fixture.base}/` });
    expect(opened.details.status, text(opened)).toBe("observed");
    expect(await evaluate(second, opened, 'localStorage.getItem("pi-marker")')).toContain(marker);
    await evaluate(second, opened, 'localStorage.removeItem("pi-marker")');
  } finally { await close(second); }
});
test("site data written in the agent profile is still there in the next session", async () => {
  const marker = `pi-${Date.now()}`;
  const first = await connectLive();
  try {
    const opened = await first.insert(first.machine, { action: "open_browser", browser: "chrome", profile: "agent", url: `${fixture.base}/` });
    expect(opened.details.status, text(opened)).toBe("observed");
    const command = await first.powershell(`(Get-CimInstance Win32_Process -Filter "ProcessId=${opened.details.target!.pid}").CommandLine`);
    expect(command).toContain("PiComputerUse\\browser-profiles\\chrome");
    if (isolated) expect(command).toContain(isolated.root + "\\PiComputerUse\\browser-profiles\\chrome");
    expect(await evaluate(first, opened, `localStorage.setItem("pi-marker", "${marker}"), localStorage.getItem("pi-marker")`)).toContain(marker);
  } finally { await close(first); }

  const second = await connectLive();
  try {
    const again = await second.insert(second.machine, { action: "open_browser", browser: "chrome", profile: "agent", url: `${fixture.base}/` });
    expect(again.details.status, text(again)).toBe("observed");
    const stored = await evaluate(second, again, 'localStorage.getItem("pi-marker")');
    expect(stored).toContain(marker);
    await evaluate(second, again, 'localStorage.removeItem("pi-marker")');
    const disposable = await second.insert(second.machine, { action: "open_browser", browser: "chrome", url: `${fixture.base}/` });
    expect(await evaluate(second, disposable, 'String(localStorage.getItem("pi-marker"))')).toContain("null");
  } finally { await close(second); }
});
