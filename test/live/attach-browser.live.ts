import { afterAll, expect, test } from "vitest";
import { addresses, connectLive, openWindow, text } from "./remote.ts";

// LPT-850/851: Playwright attaches to a Chrome or Edge that is already running, through its remote-debugging port,
// through remote debugging turned on in the running browser (chrome://inspect/#remote-debugging), or through the
// Playwright Extension, and the session's close leaves the browsers open. All browsers are started here with temporary
// profiles and --disable-sync: without it Edge signs a fresh profile into the Windows user's account and syncs their
// data into it. The human's own browser is never touched.
const live = await connectLive();
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const EXTENSION_ID = "mmlmfjhmonkocbjadbfplnigmagldckm";
const temp = (await live.powershell("$env:TEMP")).trim();
const tempWsl = (await live.runner.run("wslpath", ["-u", temp])).trim();
const run = Date.now().toString(36);
const profiles = [`pi-attach-cdp-${run}`, `pi-attach-ext-${run}`, `pi-attach-toggle-${run}`];
const CHROME = `${(await live.powershell("$env:LOCALAPPDATA")).trim()}\\Google\\Chrome\\Application\\chrome.exe`;
const ours = `-match 'pi-attach-(cdp|ext|toggle)-${run}'`;
const cleanupProfiles = () => live.powershell(`Get-CimInstance Win32_Process -Filter "Name='msedge.exe' or Name='chrome.exe'" | Where-Object { $_.CommandLine ${ours} } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; Start-Sleep 2; ${profiles.map(p => `Remove-Item -Recurse -Force -ErrorAction SilentlyContinue '${temp}\\${p}'`).join("; ")}`).catch(() => "");
afterAll(async () => { await live.close(); await cleanupProfiles(); });
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const page = (title: string) => `data:text/html,${encodeURIComponent(`<title>${title}</title><input aria-label=Field>`)}`;
const flags = (profile: string) => [`--user-data-dir=${temp}\\${profile}`, "--no-first-run", "--no-default-browser-check", "--disable-sync"];
type Element = { role?: string | null; name?: string | null; hint: string };

/** Click the first element that matches in a fresh UI read of the window, waiting up to 20 s for it to appear. */
async function click(target: string, match: (elements: Element[]) => Element | undefined) {
  let seen: Element[] = [];
  for (let i = 0; i < 40; i++) {
    const view = await live.read(target, ["ui"]).catch(() => undefined);
    seen = (view?.details.ui?.elements ?? []) as Element[];
    const element = match(seen);
    if (element) return live.insert(`computer:observation/${view!.details.observation_id}`, { action: "click", hint: element.hint });
    await sleep(500);
  }
  throw new Error(`Nothing to click in ${target}: ${JSON.stringify(seen.map(e => [e.role, e.name?.slice(0, 40)]))}`);
}

/** Read the attached page through Playwright, fill its field and read the value back. */
async function fillThroughPlaywright(window: string, value: string) {
  const snapshot = await live.read(window, ["dom"]);
  expect(snapshot.details.status, text(snapshot)).toBe("observed");
  expect(text(snapshot)).toMatch(/textbox "Field"/);
  // The page loaded before Playwright attached; its tab still reports that.
  expect(snapshot.details.dom?.tabs.find(tab => tab.active)).toMatchObject({ load: "complete" });
  const filled = await live.insert(`computer:observation/${snapshot.details.observation_id}`, { action: "fill", target: { label: "Field" }, text: value });
  expect(filled.details.status, text(filled)).toBe("delivered");
  expect(text(await live.read(window, ["dom"]))).toMatch(new RegExp(`textbox "Field"[^\\n]*: ${value}`));
}

test("CDP: a browser started with a debugging port", async () => {
  // The agent starts the debugging browser itself (YOLO open by path; the driver allows remote-debugging switches).
  const window = await openWindow(live, live.machine, EDGE, [...flags(profiles[0]), "--remote-debugging-port=0", page("Attach CDP target")], "Attach CDP target");
  const attached = await live.insert(window, { action: "attach_browser" });
  expect(attached.details.status, text(attached)).toBe("delivered");
  expect(attached.details.state).toMatchObject({ via: "cdp", title: "Attach CDP target" });
  await fillThroughPlaywright(window, "cdp-ok");
});

test("Extension: the connection is approved on the extension's page with ordinary input", async () => {
  // The Web Store package carries its key, so the unpacked copy keeps the extension id Playwright opens.
  const unpacked = `${tempWsl}/pi-playwright-extension`;
  await live.runner.run("bash", ["-c", `test -f ${unpacked}/manifest.json || { curl -sSL -o /tmp/pi-playwright-extension.crx "https://clients2.google.com/service/update2/crx?response=redirect&prodversion=140.0&acceptformat=crx3&x=id%3D${EXTENSION_ID}%26uc" && mkdir -p ${unpacked} && python3 -c 'import sys, zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])' /tmp/pi-playwright-extension.crx ${unpacked} && test -f ${unpacked}/manifest.json; }`]);
  const window = await openWindow(live, live.machine, EDGE, [...flags(profiles[1]), `--load-extension=${temp}\\pi-playwright-extension`,
    "--disable-features=DisableLoadExtensionCommandLineSwitch", page("Attach extension target")], "Attach extension target");

  // Edge warns about an unpacked extension in a dialog of its own; dismiss it.
  const dialog = await openWindowIfShown("Turn off extensions in developer mode");
  if (dialog) await click(dialog, elements => elements.find(e => e.role === "Button" && e.name === "Not now"));

  // Attaching waits for approval; meanwhile approve the target tab on the extension's connect page in that window.
  const attaching = live.insert(window, { action: "attach_browser" });
  await click(window, elements => {
    const row = elements.findIndex(e => e.role === "Text" && e.name === "Attach extension target");
    return row < 0 ? undefined : elements.slice(row).find(e => e.role === "Button" && e.name === "Allow & select");
  });
  const attached = await attaching;
  expect(attached.details.status, text(attached)).toBe("delivered");
  expect(attached.details.state).toMatchObject({ via: "extension", title: "Attach extension target" });
  await fillThroughPlaywright(window, "extension-ok");
}, 240_000);

test("Toggle: remote debugging turned on in the running browser, after its Allow prompt", async () => {
  const window = await openWindow(live, live.machine, CHROME, [...flags(profiles[2]), page("Attach toggle target")], "Attach toggle target");
  // Turn on chrome://inspect/#remote-debugging the way a person would: a new tab, the address, the switch.
  await click(window, elements => elements.find(e => e.role === "Button" && e.name === "New Tab"));
  const blank = await live.read(window, ["ui"]);
  const address = (blank.details.ui!.elements as Element[]).find(e => e.role === "Edit" && e.name === "Address and search bar")!;
  const typed = await live.insert(`computer:observation/${blank.details.observation_id}`, { action: "set_value", hint: address.hint, text: "chrome://inspect/#remote-debugging" });
  expect(typed.details.status, text(typed)).toBe("delivered");
  // Background Enter does not reach Chrome's address bar, and its suggestion popup can hold the foreground; the
  // suggestion that names the address navigates there.
  await click(window, elements => elements.find(e => e.role === "ListItem" && e.name === "chrome://inspect/#remote-debugging"));
  await click(window, elements => elements.find(e => e.role === "CheckBox" && e.name === "Allow remote debugging for this browser instance"));

  // Chrome asks in a window of its own for every client; approve it while the attach waits.
  const attaching = live.insert(window, { action: "attach_browser" });
  let prompt: string | undefined;
  for (let i = 0; !prompt && i < 40; i++) {
    prompt = addresses(await live.search(live.windows, "Allow remote debugging?"), "window")[0];
    if (!prompt) await sleep(500);
  }
  if (!prompt) throw new Error("Chrome's Allow prompt did not appear.");
  await click(prompt, elements => elements.find(e => e.role === "Button" && e.name === "Allow"));
  const attached = await attaching;
  expect(attached.details.status, text(attached)).toBe("delivered");
  expect(attached.details.state).toMatchObject({ via: "toggle" });

  // The window shows the inspect tab; switch to the target by its title, which attached tabs report.
  const snapshot = await live.read(window, ["dom"]);
  const target = snapshot.details.dom!.tabs.find(tab => tab.title === "Attach toggle target");
  expect(target, JSON.stringify(snapshot.details.dom!.tabs)).toBeTruthy();
  const switched = await live.insert(`computer:observation/${snapshot.details.observation_id}`, { action: "switch_tab", tab: target!.id });
  expect(switched.details.status, text(switched)).toBe("delivered");
  await fillThroughPlaywright(window, "toggle-ok");

  // Closing the computer session detaches: all three browsers keep running.
  await live.close();
  const running = await live.powershell(`@(Get-CimInstance Win32_Process -Filter "Name='msedge.exe' or Name='chrome.exe'" | Where-Object { $_.CommandLine ${ours} -and $_.CommandLine -notmatch '--type=' }).Count`);
  expect(Number(running.trim())).toBe(3);
}, 240_000);

/** A window with this exact title, if it appears within a few seconds. */
async function openWindowIfShown(title: string): Promise<string | undefined> {
  for (let i = 0; i < 10; i++) {
    const found = JSON.stringify((await live.search(live.windows, title)).details.state).match(/"window_ref":"(w-[^"]+)"/);
    if (found) return `computer:window/${found[1]}`;
    await sleep(500);
  }
  return undefined;
}
