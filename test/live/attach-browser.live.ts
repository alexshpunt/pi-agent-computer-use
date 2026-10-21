import { afterAll, expect, test } from "vitest";
import { addresses, connectLive, openWindow, text } from "./remote.ts";

// LPT-850: Playwright attaches to a Chrome or Edge that is already running, through its remote-debugging port or
// through the Playwright Extension, and the session's close leaves the browser open. Both browsers are started here
// with temporary profiles and --disable-sync: without it Edge signs a fresh profile into the Windows user's account
// and syncs their data into it. The human's own browser is never touched.
const live = await connectLive();
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const EXTENSION_ID = "mmlmfjhmonkocbjadbfplnigmagldckm";
const temp = (await live.powershell("$env:TEMP")).trim();
const tempWsl = (await live.runner.run("wslpath", ["-u", temp])).trim();
const run = Date.now().toString(36);
const profiles = [`pi-attach-cdp-${run}`, `pi-attach-ext-${run}`];
const cleanupProfiles = () => live.powershell(`Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -match 'pi-attach-(cdp|ext)-${run}' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; Start-Sleep 2; ${profiles.map(p => `Remove-Item -Recurse -Force -ErrorAction SilentlyContinue '${temp}\\${p}'`).join("; ")}`).catch(() => "");
afterAll(async () => { await live.close(); await cleanupProfiles(); });
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const page = (title: string) => `data:text/html,${encodeURIComponent(`<title>${title}</title><input aria-label=Field>`)}`;
const flags = (profile: string) => [`--user-data-dir=${temp}\\${profile}`, "--no-first-run", "--no-default-browser-check", "--disable-sync"];
type Element = { role?: string | null; name?: string | null; hint: string };

/** Read the attached page through Playwright, fill its field and read the value back. */
async function fillThroughPlaywright(window: string, value: string) {
  const snapshot = await live.read(window, ["dom"]);
  expect(snapshot.details.status, text(snapshot)).toBe("observed");
  expect(text(snapshot)).toMatch(/textbox "Field"/);
  const filled = await live.insert(`computer:observation/${snapshot.details.observation_id}`, { action: "fill", target: { label: "Field" }, text: value });
  expect(filled.details.status, text(filled)).toBe("delivered");
  expect(text(await live.read(window, ["dom"]))).toMatch(new RegExp(`textbox "Field"[^\\n]*: ${value}`));
}

test("CDP: a browser started with a debugging port", async () => {
  // CUA refuses to launch anything with a remote-debugging switch, so the browser is started the way a person would.
  const args = [...flags(profiles[0]), "--remote-debugging-port=0", page("Attach CDP target")].map(arg => `'${arg.replace(/'/g, "''")}'`).join(",");
  await live.powershell(`Start-Process -FilePath '${EDGE}' -ArgumentList ${args}`);
  let window: string | undefined;
  for (let i = 0; !window && i < 40; i++) {
    window = addresses(await live.search(live.machine, "Attach CDP target"), "window")[0];
    if (!window) await sleep(500);
  }
  if (!window) throw new Error("The debugging browser's window did not appear.");
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
  const click = async (target: string, match: (elements: Element[]) => Element | undefined) => {
    for (let i = 0; i < 40; i++) {
      const view = await live.read(target, ["ui"]).catch(() => undefined);
      const element = view?.details.ui && match(view.details.ui.elements as Element[]);
      if (element) return live.insert(`computer:observation/${view!.details.observation_id}`, { action: "click", hint: element.hint });
      await sleep(500);
    }
    throw new Error(`Nothing to click in ${target}.`);
  };
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

  // Closing the computer session detaches: both browsers keep running.
  await live.close();
  const running = await live.powershell(`@(Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -match 'pi-attach-(cdp|ext)-${run}' -and $_.CommandLine -notmatch '--type=' }).Count`);
  expect(Number(running.trim())).toBe(2);
}, 240_000);

/** A window with this exact title, if it appears within a few seconds. */
async function openWindowIfShown(title: string): Promise<string | undefined> {
  for (let i = 0; i < 10; i++) {
    const found = JSON.stringify((await live.search(live.machine, title)).details.state).match(/"window_ref":"(w-[^"]+)"/);
    if (found) return `computer:window/${found[1]}`;
    await sleep(500);
  }
  return undefined;
}
