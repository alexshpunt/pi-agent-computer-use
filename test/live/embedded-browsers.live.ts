import { execFileSync } from "node:child_process";
import { afterAll, expect, test } from "vitest";
import { connectLive, openWindow, serveFixture, text } from "./remote.ts";
import { machineConfig } from "../../src/machine.ts";

// LPT-857..859: Playwright attaches to browsers embedded in other apps. Everything here is started by the check in
// temporary folders on the machine: a portable VS Code (Electron) with its own data folder, the Pi Browser Bridge
// installed into that portable VS Code only, and a PowerShell WinForms window hosting WebView2. The WebView2 policy
// for powershell.exe is set only while the check runs.
const live = await connectLive();
const fixture = await serveFixture(live.runner);
const temp = (await live.powershell("$env:TEMP")).trim();
const tempWsl = (await live.runner.run("wslpath", ["-u", temp])).trim();
const vscode = `${temp}\\pi-vscode\\app\\Code.exe`;
const killVsCode = () => live.powershell(`Get-CimInstance Win32_Process -Filter "Name='Code.exe'" | Where-Object { $_.ExecutablePath -like '*\\Temp\\pi-vscode\\*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; Start-Sleep 2`).catch(() => "");
afterAll(async () => {
  await live.close();
  await killVsCode();
  await live.powershell(`Get-Process powershell -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like 'WEBVIEW2*' } | Stop-Process -Force -ErrorAction SilentlyContinue`).catch(() => "");
  fixture.close();
});
const vscodeArgs = ["--new-window", "--skip-welcome", "--skip-release-notes", "--disable-workspace-trust"];

/** A portable VS Code in the machine's temp folder: its own data folder, the bridge installed and its proposed API allowed. */
async function portableVsCode() {
  const root = `${tempWsl}/pi-vscode`;
  await live.runner.run("bash", ["-c", `set -e; mkdir -p ${root}; cd ${root}
[ -f code.zip ] || curl -sSL -o code.zip https://update.code.visualstudio.com/latest/win32-x64-archive/stable
[ -f app/Code.exe ] || python3 -c "import zipfile;zipfile.ZipFile('code.zip').extractall('app')"
mkdir -p app/data; rm -f app/data/argv.json`], { timeoutMs: 600_000 });
  // The same installer a user runs: the extension, and its proposed API allowed in that VS Code's argv.json.
  execFileSync("scripts/install-vscode-bridge.sh", [`${root}/app/bin/code.cmd`, `${root}/app/data/argv.json`, (await machineConfig(process.cwd(), "zinpc")).ssh], { stdio: "ignore" });
}

/** Read the attached page, then navigate it to the fixture and fill its field through Playwright. */
async function driveFixture(window: string, value: string) {
  const snapshot = await live.read(window, ["dom"]);
  expect(snapshot.details.status, text(snapshot)).toBe("observed");
  const navigated = await live.insert(`computer:observation/${snapshot.details.observation_id}`, { action: "navigate", url: `${fixture.base}/wait` });
  expect(navigated.details.status, text(navigated)).toBe("delivered");
  const filled = await live.insert(`computer:observation/${navigated.details.observation_id}`, { action: "fill", target: { label: "Name" }, text: value });
  expect(filled.details.status, text(filled)).toBe("delivered");
  expect(text(filled)).toMatch(new RegExp(`textbox "Name"[^\\n]*: ${value}`));
}

test("Electron: an app started with a debugging port exposes its own pages", async () => {
  await portableVsCode();
  const window = await openWindow(live, live.machine, vscode, [...vscodeArgs, "--remote-debugging-port=0"], "Visual Studio Code");
  const attached = await live.insert(window, { action: "attach_browser" });
  expect(attached.details.status, text(attached)).toBe("delivered");
  expect(attached.details.state).toMatchObject({ via: "cdp" });
  // The workbench itself is one of the app's pages.
  const snapshot = await live.read(window, ["dom"]);
  expect(snapshot.details.dom?.tabs.some(tab => tab.url.includes("workbench.html")), JSON.stringify(snapshot.details.dom?.tabs)).toBe(true);
  await live.close();
  await killVsCode();
}, 900_000);

test("VS Code: the integrated browser through the Pi Browser Bridge", async () => {
  const window = await openWindow(live, live.machine, vscode, vscodeArgs, "Visual Studio Code");
  // The bridge publishes its endpoint once the extension host has started.
  let attached;
  for (let i = 0; i < 20; i++) {
    attached = await live.insert(window, { action: "attach_browser" });
    if (attached.details.status === "delivered") break;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  expect(attached!.details.status, text(attached!)).toBe("delivered");
  expect(attached!.details.state).toMatchObject({ via: "vscode" });
  await driveFixture(window, "vscode-bridge-ok");
  await live.close();
  await killVsCode();
}, 300_000);

/** A PowerShell WinForms window hosting WebView2 from the official NuGet package, in the machine's temp folder. */
async function webview2App(title: string): Promise<{ path: string; args: string[] }> {
  const dlls = `${temp}\\pi-webview2`;
  await live.runner.run("bash", ["-c", `set -e; d=${tempWsl}/pi-webview2; mkdir -p $d; cd $d
[ -f wv2.nupkg ] || curl -sSL -o wv2.nupkg https://www.nuget.org/api/v2/package/Microsoft.Web.WebView2
[ -f WebView2Loader.dll ] || python3 -c "
import zipfile
z = zipfile.ZipFile('wv2.nupkg')
for n in z.namelist():
    if n.startswith(('lib/net462/', 'runtimes/win-x64/native/')) and n.endswith('.dll'): open(n.split('/')[-1], 'wb').write(z.read(n))"`], { timeoutMs: 300_000 });
  const form = `$d = '${dlls}'; $env:PATH = "$d;$env:PATH"
Add-Type -Path "$d\\Microsoft.Web.WebView2.Core.dll"; Add-Type -Path "$d\\Microsoft.Web.WebView2.WinForms.dll"; Add-Type -AssemblyName System.Windows.Forms
$f = New-Object Windows.Forms.Form; $f.Text = '${title}'; $f.Width = 900; $f.Height = 700
$w = New-Object Microsoft.Web.WebView2.WinForms.WebView2; $w.Dock = 'Fill'
$p = New-Object Microsoft.Web.WebView2.WinForms.CoreWebView2CreationProperties; $p.UserDataFolder = "$d\\profile"; $w.CreationProperties = $p
$f.Controls.Add($w); $w.Source = [Uri]'about:blank'
[void]$f.ShowDialog()`;
  return { path: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    args: ["-NoProfile", "-WindowStyle", "Hidden", "-EncodedCommand", Buffer.from(form, "utf16le").toString("base64")] };
}

/** Attach once the WebView2 control has started its browser process. */
async function attachWebView2(window: string) {
  let attached;
  for (let i = 0; i < 10; i++) {
    attached = await live.insert(window, { action: "attach_browser" });
    if (attached.details.status === "delivered") break;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  expect(attached!.details.status, text(attached!)).toBe("delivered");
  expect(attached!.details.state).toMatchObject({ via: "cdp" });
  await driveFixture(window, "webview2-ok");
}

test("WebView2: an app the agent starts with debugging", async () => {
  const app = await webview2App("WEBVIEW2 TARGET");
  const opened = await live.insert(live.machine, { action: "open", ...app, debugging: true });
  expect(opened.details.status, text(opened)).toBe("observed");
  await attachWebView2(`computer:window/${opened.details.window_ref}`);
}, 600_000);

// The per-exe WebView2 policy needs administrator rights: with UAC, Windows asks on that machine's secure desktop,
// so this runs only when a person there approves (LIVE_UAC=1).
test.runIf(process.env.LIVE_UAC === "1")("WebView2: an app whose debugging was turned on through the WebView2 policy", async () => {
  const app = await webview2App("WEBVIEW2 POLICY TARGET");
  const on = await live.insert(live.machine, { action: "webview2_debugging", app: "powershell.exe", enabled: true });
  expect(on.details.status, text(on)).toBe("delivered");
  try {
    await attachWebView2(await openWindow(live, live.machine, app.path, app.args, "WEBVIEW2 POLICY TARGET"));
  } finally {
    const off = await live.insert(live.machine, { action: "webview2_debugging", app: "powershell.exe", enabled: false });
    expect(off.details.state).toMatchObject({ value: null });
  }
}, 600_000);
