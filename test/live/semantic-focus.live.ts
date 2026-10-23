import { afterAll, expect, test } from "vitest";
import { connectLive, nativeForm, openWindow, text, WINDOWS_POWERSHELL_PATH as POWERSHELL } from "./remote.ts";
import { computerSource } from "../../src/computer-address.ts";

// LPT-626: strict UIA actions must not take the foreground or move their target to another virtual desktop.
// Everything runs in a disposable Windows Sandbox: a sentinel console holds the foreground, a minimized sampler
// reads the foreground window every 20 ms and reports which titles took it, and a second virtual desktop is
// created inside the guest only.
const live = await connectLive();
let sandbox: string | undefined;
afterAll(async () => { if (sandbox) await live.insert(sandbox, { action: "close" }).catch(() => undefined); await live.close(); });
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const PAGE = `<title>Semantic targets</title><button onclick="this.textContent='Count '+(++window.n||(window.n=1))">Count 0</button>
<select size=3 aria-label=Pick><option>alpha<option>beta<option>gamma</select><input aria-label=Field>`;
const SAMPLER = `Add-Type -Name U -Namespace W -MemberDefinition '[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n);'
$sb = New-Object System.Text.StringBuilder 256; $n = 0; $who = @{}; $Host.UI.RawUI.WindowTitle = 'FGPROBE n=0 who='
$seen = $false
while ($true) { $h = [W.U]::GetForegroundWindow(); [void]$sb.Clear(); [void][W.U]::GetWindowText($h, $sb, 256); $t = $sb.ToString(); $n++
  if ($t -like '*SENTINEL*') { $seen = $true } elseif ($seen) { $k = ($t -replace '[^A-Za-z0-9 ]', '_'); if ($k.Length -gt 40) { $k = $k.Substring($k.Length - 40) }; $who[$k] = 1 + [int]$who[$k] }
  if ($n % 10 -eq 0) { $Host.UI.RawUI.WindowTitle = 'FGPROBE n=' + $n + ' who=' + (($who.GetEnumerator() | ForEach-Object { $_.Key + ':' + $_.Value }) -join ';') }
  Start-Sleep -Milliseconds 20 }`;
const encoded = (script: string) => Buffer.from(script, "utf16le").toString("base64");
const CMD = "C:\\Windows\\System32\\cmd.exe";
type Element = { role?: string | null; name?: string | null; hint: string; value?: unknown; selected?: unknown };

test("strict UIA actions keep the sentinel foreground and the target's desktop", async () => {
  const opened = await live.insert(live.machine, { action: "open_sandbox" });
  expect(opened.details.status, text(opened)).toBe("delivered");
  sandbox = computerSource("sandbox", opened.details.sandbox_ref!);
  const open = (path: string, args: string[], title: string) => openWindow(live, sandbox!, path, args, title);
  const edge = await open("C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    ["--no-first-run", "--no-default-browser-check", "--new-window", `data:text/html,${encodeURIComponent(PAGE)}`], "Semantic targets");
  // The guest has neither Notepad (its System32 stub needs the Store app) nor Character Map.
  const native = await open(POWERSHELL, nativeForm("NATIVE TARGET"), "NATIVE TARGET");
  const sentinel = await open(CMD, ["/k", "title SENTINEL"], "SENTINEL");
  await open(POWERSHELL, ["-NoProfile", "-WindowStyle", "Minimized", "-EncodedCommand", encoded(SAMPLER)], "FGPROBE");

  const thieves = async () => {
    await sleep(600);
    const who = JSON.stringify((await live.search(sandbox!, "FGPROBE")).details.state).match(/FGPROBE n=\d+ who=([^"\\]*)/)?.[1] ?? "";
    return who.split(";").filter(Boolean);
  };
  const ui = async (window: string) => {
    const view = await live.read(window, ["ui"]);
    if (!view.details.ui) {
      const ref = window.split("/").pop();
      const listed = (JSON.parse(JSON.stringify((await live.search(sandbox!, "regex:.")).details.state)).windows as { window_ref?: string; title?: string; app_name?: string; minimized?: boolean; is_on_screen?: boolean }[])
        .map(w => `${w.window_ref === ref ? "*" : ""}${w.app_name}|${w.title}|min=${w.minimized}|on=${w.is_on_screen}`);
      throw new Error(`No UI for ${window}: STATE=${JSON.stringify(view.details.state)} WINDOWS=${JSON.stringify(listed)}`.replace(/\n/g, " "));
    }
    const desktop = view.details.source_identity?.virtual_desktop;
    return { view, elements: view.details.ui.elements as Element[],
      desktop: desktop?.status === "sampled" ? { desktop_id: desktop.desktop_id, on_current_desktop: desktop.on_current_desktop } : desktop };
  };
  const act = async (window: string, match: (e: Element) => boolean, action: Record<string, unknown>) => {
    const { view, elements } = await ui(window);
    const element = elements.find(match);
    // An app can expose only its frame through UIA while on another virtual desktop; then nothing is dispatched.
    if (!element) return "absent";
    const done = await live.insert(`computer:observation/${view.details.observation_id}?hint=${encodeURIComponent(element.hint)}`, action);
    return done.details.status === "delivered" ? "delivered" : String((done.details.state as { code?: string } | undefined)?.code ?? done.details.status);
  };
  const button = (e: Element) => e.role === "Button" && /^Count/.test(e.name ?? "");
  const item = (name: string) => (e: Element) => /ListItem/.test(e.role ?? "") && e.name === name;
  const edit = (e: Element) => e.role === "Edit";
  const round = async (label: string) => {
    const edgeDesktop = (await ui(edge)).desktop, nativeDesktop = (await ui(native)).desktop;
    const before = await thieves();
    const outcomes = {
      edge: [await act(edge, button, { action: "invoke" }), await act(edge, item("beta"), { action: "select" }), await act(edge, edit, { action: "set_value", text: label })],
      native: [await act(native, button, { action: "invoke" }), await act(native, item("gamma"), { action: "select" }), await act(native, edit, { action: "set_value", text: label })],
    };
    const after = await thieves();
    const readback = await ui(native);
    console.log(label, JSON.stringify({ outcomes, before, after }));
    // Neither target ever took the foreground.
    expect(after.filter(entry => /NATIVE TARGET|Semantic targets/.test(entry))).toEqual([]);
    // Each target stays on the desktop it started on.
    expect((await ui(edge)).desktop).toEqual(edgeDesktop);
    expect(readback.desktop).toEqual(nativeDesktop);
    return { outcomes, readback: readback.elements };
  };

  const focus = async (window: string) => {
    const state = await live.read(window, ["state"]);
    expect((await live.insert(`computer:window-state/${state.details.window_state_id}`, { action: "focus" })).details.status).toBe("delivered");
    await sleep(1000);
  };
  await focus(sentinel);
  const current = await round("current");
  // Edge reports its page elements under another process, so the driver refuses them before any call.
  expect(current.outcomes.edge).toEqual(Array(3).fill("semantic_element_process_changed"));
  expect(current.outcomes.native).toEqual(["delivered", "delivered", "delivered"]);
  expect(current.readback.find(button)?.name).toBe("Count 1");
  expect(current.readback.find(item("gamma"))?.selected).toBe(true);
  expect(current.readback.find(edit)?.value).toBe("current");

  // A second virtual desktop inside the guest; both targets stay behind on the first.
  const view = await live.read(sentinel, ["image"]);
  const created = await live.insert(`computer:observation/${view.details.observation_id}?delivery=foreground`, { action: "hotkey", keys: ["ctrl", "win", "d"] });
  expect(created.details.status).toBe("delivered");
  await sleep(1500);
  await open(CMD, ["/k", "title SENTINEL2"], "SENTINEL2");
  expect((await ui(native)).desktop).toMatchObject({ on_current_desktop: false });
  const other = await round("other");
  // The WinForms target exposes only its frame there, so its content actions are not dispatched.
  expect(other.outcomes.native).toEqual(["absent", "absent", "absent"]);
});
