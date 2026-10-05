import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { BrowserProfile, finishProfile } from "../src/browser-profile.ts";
import { CuaBrowser } from "../src/cua-browser.ts";
import { McpDriver } from "../src/driver.ts";
import { loadComputerConfig } from "../src/config.ts";
import { WindowHighlights, findWindowOverlay } from "../src/window-highlights.ts";
import { startOverlayPeer } from "../src/window-overlay-peer.ts";
import { createBrowserProfileSite } from "../test/fixtures/browser-profile-site.mjs";

// Opt-in only: one new isolated browser, the normal production adapter, no changes to Pi tools.
const args = process.argv.slice(2);
assert.ok(args.length <= 1 && (!args.length || /^[1-9]\d*$/.test(args[0])), "Usage: node --experimental-transform-types scripts/profile-browser.mjs [1..20 samples]");
const repeats = Number(args[0] ?? 5);
assert.ok(repeats <= 20, "At most 20 samples per operation.");
const directory = `.tmp/browser-profile/run-${Date.now()}`;
await mkdir(directory, { recursive: true });
const config = await loadComputerConfig(process.cwd());
const profile = new BrowserProfile();
const cancellation = new AbortController();
const interrupt = () => cancellation.abort();
process.on('SIGINT', interrupt);
process.on('SIGTERM', interrupt);
const run = promisify(execFile);
const windowsState = async pids => {
  const script = `$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';@{drivers=@(Get-Process -Name cua-driver -ErrorAction SilentlyContinue|ForEach-Object {$_.Id});profiles=@(Get-ChildItem -LiteralPath \"$env:LOCALAPPDATA\\CuaDriver\\BrowserProfiles\" -ErrorAction SilentlyContinue|ForEach-Object {$_.Name});owned_alive=@(${pids.length ? pids.map(p => `[bool](Get-Process -Id ${p} -ErrorAction SilentlyContinue)`).join(',') : ''})}|ConvertTo-Json -Compress`;
  const command = process.platform === 'win32' ? 'powershell.exe' : '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
  const result = await run(command, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    timeout: 20000, encoding: 'utf8', env: { ...process.env, ...(config.interop ? { WSL_INTEROP: config.interop } : {}) },
  });
  return JSON.parse(result.stdout);
};
const baseline = await windowsState([]);
const ownedPids = new Set();
const highlights = new WindowHighlights(async () => {
  const peer = await startOverlayPeer(await findWindowOverlay(), [], config.interop);
  ownedPids.add(peer.ready.pid); return peer;
});
const browser = new CuaBrowser(async () => {
  const driver = new McpDriver(config);
  return {
    call: (name, input, signal) => profile.child(`native.${name}${name === 'get_browser_state' ? input.snapshot_format ? '.semantic' : '.bind' : ''}`, async () => {
      const result = await driver.call(name, input, signal);
      if (Number.isSafeInteger(result.structuredContent?.prepared_pid)) ownedPids.add(result.structuredContent.prepared_pid);
      return result;
    }, result => result.isError || result.structuredContent?.status === 'refused' || result.structuredContent?.effect === 'refused' ? 'failed' : 'returned'),
    identity: (target, create, signal) => profile.child(create ? 'identity.create' : 'identity.check', () => driver.identity(target, create, signal), result => result ? 'matched' : 'missing'),
    close: () => profile.child('transport.close', () => driver.close()),
  };
}, undefined, (frame, signal) => profile.child('frame.flash', () => highlights.flash(frame, signal), result => result.status));
let site;
let completed = false;
let stage = 'fixture_start';
const effect = async (key, before) => {
  // Bounded read-only verification outside the measured call. Never replay input.
  for (let i = 0; i < 20 && site.state[key] <= before; i++) await delay(50);
  assert.ok(site.state[key] > before, 'Synthetic effect was not confirmed.');
};
const visual = result => {
  const image = result.content.filter(b => b.type === 'image');
  assert.equal(image.length, 1);
  assert.equal(result.details.highlight?.status, 'shown', 'Normal observation frame must remain enabled.');
  assert.equal(result.details.foreground?.native.landed_on_target, true);
  if (Number.isSafeInteger(result.details.agent_image.native.pid)) ownedPids.add(result.details.agent_image.native.pid);
};
const call = async (operation, input, label, phase = 'warm', verify = async () => {}) => {
  stage = label;
  const expected = operation === 'act' && input.observe === false ? 'acted' : operation === 'tabs' ? 'listed' : operation === 'close' ? 'closed' : 'observed';
  const result = await profile.operation(label, phase, async () => {
    const value = await browser.call(operation, input, cancellation.signal);
    return { status: value.details.status, ...value };
  }, expected, async result => {
    if (expected === 'observed') visual(result);
    await verify(result.details);
  });
  const sample = profile.samples.at(-1);
  console.log(`${phase.padEnd(7)} ${label.padEnd(24)} ${sample.duration_ms.toFixed(1).padStart(8)} ms  children=${sample.children.length} remaining=${sample.remaining_ms.toFixed(1)} ms`);
  return result.details;
};
const hint = (state, name) => {
  const matches = state.elements.filter(e => e.name === name);
  assert.equal(matches.length, 1, 'One synthetic hint is required.'); return matches[0].hint;
};
let cleanup;
try {
  site = await createBrowserProfileSite();
  console.log('CUA 0.33.2 browser adapter wall time; RPC includes transport. Pi/model/TUI, verification and report writes excluded.');
  let state = await call('open', { url: site.url }, 'open', 'cold', async state => assert.ok(state.text.includes('Browser timing fixture')));
  // Private synthetic proof for grounding the pixel region. Never included in report.json.
  const first = await browser.call('observe', { image_only: true });
  assert.equal(first.details.status, 'observed'); visual(first);
  await writeFile(`${directory}/synthetic-overview.png`, Buffer.from(first.content.find(b => b.type === 'image').data, 'base64'));
  for (let iteration = 0; iteration < repeats; iteration++) {
    await call('tabs', {}, 'tabs', 'warm', async s => assert.equal(s.tabs.length, 1));
    state = await call('focus', { tab: 1 }, 'focus');
    state = await call('observe', {}, 'overview');
    const image = await call('observe', { image_only: true }, 'image_only');
    // The bottom-middle of the synthetic overview is the large empty pixel test area, not chrome.
    const width = image.screenshot.width, height = image.screenshot.height;
    const zoom = { x: width * .34, y: height * .65, width: width * .102, height: height * .23 };
    await call('observe', { zoom }, 'zoom');
    state = await call('observe', {}, 'setup_overview', 'setup');
    for (const [mode, suffix] of [[false, 'none'], [undefined, 'image'], [true, 'semantic']]) {
      const before = site.state.clicks;
      const input = { click: hint(state, 'Count'), ...(mode === undefined ? {} : { observe: mode }) };
      const result = await call('act', input, `click_hint_${suffix}`, 'warm', () => effect('clicks', before));
      if (mode === true) state = result;
    }
    let before = site.state.inputs;
    await call('act', { fill: hint(state, 'Message'), text: `sample ${iteration}`, observe: false }, 'fill', 'warm', () => effect('inputs', before));
    before = site.state.hovers;
    await call('act', { hover: hint(state, 'Next page'), observe: false }, 'hover', 'warm', () => effect('hovers', before));
    state = await call('observe', { image_only: true }, 'setup_pixel', 'setup');
    before = site.state.clicks;
    await call('act', { click: { x: state.screenshot.width * .5, y: state.screenshot.height * .7 }, observe: false }, 'click_point', 'warm', () => effect('clicks', before));
    state = await call('observe', { image_only: true }, 'setup_zoom', 'setup');
    const detail = await call('observe', { zoom }, 'setup_detail', 'setup');
    before = site.state.clicks;
    await call('act', { click: { x: detail.screenshot.width / 2, y: detail.screenshot.height / 2 }, observe: false }, 'click_zoom_point', 'warm', () => effect('clicks', before));
    before = site.state.scrolls;
    await call('act', { scroll: { hint: hint(state = await call('observe', {}, 'setup_scroll', 'setup'), 'Next page'), delta_y: 300 }, observe: false }, 'scroll', 'warm', () => effect('scrolls', before));
    before = site.state.visits;
    await call('act', { navigate: site.url + 'next', observe: false }, 'navigate_none', 'warm', () => effect('visits', before));
    before = site.state.visits;
    state = await call('act', { navigate: site.url + 'next', observe: true }, 'navigate_semantic', 'warm', () => effect('visits', before));
  }
  await call('close', {}, 'close', 'warm');
  completed = true;
} catch { console.error(`FAILED at ${stage}; no input replay. Partial timings will be saved.`); }
finally {
  cleanup = await finishProfile(completed, {
    browser: async () => { const result = await browser.call('close', {}); assert.equal(result.details.status, 'closed'); },
    helper: () => highlights.close(),
    fixture: async () => { await site?.close(); },
    native: async () => {
      const remaining = await windowsState([...ownedPids]);
      assert.ok(remaining.owned_alive.every(v => !v), 'Owned process still alive.');
      assert.ok(remaining.drivers.every(pid => baseline.drivers.includes(pid)), 'New Driver process remains.');
      assert.ok(remaining.profiles.every(p => baseline.profiles.includes(p)), 'New profile remains.');
      assert.ok(baseline.profiles.every(p => remaining.profiles.includes(p)), 'Pre-existing profile disappeared.');
    },
  });
}
const report = { schema: 1, driver: '0.33.2', platform: process.platform, warm_loop_repeats: repeats,
  boundary: 'Production CuaBrowser.call wall time; native RPC includes IPC/transport/lazy startup, not isolated native capture time. Pi/model/TUI, fixture verification and output writes excluded.',
  first_use: 'Each child cold=true is its first invocation, not necessarily process startup. Cold open contains Driver, identity peer and Qt helper startup.',
  ...cleanup, summary: profile.summary(), samples: profile.samples };
await writeFile(`${directory}/report.json`, JSON.stringify(report, null, 2) + '\n');
console.log('\nphase   operation                   n    p50 ms    p95 ms');
for (const row of report.summary.filter(r => r.phase !== 'setup')) console.log(`${row.phase.padEnd(7)} ${row.operation.padEnd(26)} ${String(row.count).padStart(2)} ${row.p50_ms.toFixed(1).padStart(9)} ${row.p95_ms.toFixed(1).padStart(9)}`);
const zooms = profile.samples.filter(s => s.operation === 'zoom' && s.success);
if (zooms.length) {
  console.log('\nFirst warm zoom: ordered child calls');
  for (const child of zooms[0].children) console.log(`${child.start_ms.toFixed(1).padStart(7)} +${child.duration_ms.toFixed(1).padStart(7)} ms ${child.name} ${child.outcome}`);
  console.log(`Remaining adapter time: ${zooms[0].remaining_ms.toFixed(1)} ms`);
}
console.log(`\nsuccess=${report.success} cleanup=${JSON.stringify(report.cleanup)} report=${directory}/report.json`);
if (!report.success) process.exitCode = 1;
process.off('SIGINT', interrupt);
process.off('SIGTERM', interrupt);