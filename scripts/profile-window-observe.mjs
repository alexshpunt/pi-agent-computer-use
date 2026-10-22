import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { BrowserProfile, finishProfile } from "../src/browser-profile.ts";
import { ComputerSession } from "../src/session.ts";
import { McpDriver } from "../src/driver.ts";
import { ReactiveAnimationDriver, loadReactiveAnimationConfig } from "../src/reactive-animation.ts";
import { loadComputerConfig } from "../src/config.ts";
import { WindowHighlights, findWindowOverlay } from "../src/window-highlights.ts";
import { startOverlayPeer } from "../src/window-overlay-peer.ts";
import { createUiResourcesSite } from "../test/fixtures/ui-resources-site.mjs";
import { openCompleteInputWindow } from "./complete-input-window.mjs";

// Opt-in profiling only. Normal tool registration and safety checks are unchanged.
const args = process.argv.slice(2);
assert.ok(args.length <= 1 && (!args.length || /^[1-9]\d*$/.test(args[0])), "Usage: node --experimental-transform-types scripts/profile-window-observe.mjs [1..20 samples]");
const repeats = Number(args[0] ?? 10);
assert.ok(repeats <= 20, "At most 20 samples per mode.");
const directory = `.tmp/window-observe-profile/run-${Date.now()}`;
await mkdir(directory, { recursive: true });
const config = await loadComputerConfig(process.cwd());
const profile = new BrowserProfile();
const native = new ReactiveAnimationDriver(new McpDriver(config), await loadReactiveAnimationConfig(process.cwd()));
const abort = new AbortController();
const interrupt = () => abort.abort();
process.on("SIGINT", interrupt); process.on("SIGTERM", interrupt);
const decorated = {
  call: (name, args, signal, options) => profile.child(`native.${name}`, () => native.call(name, args, signal, options), r => r.isError ? "failed" : "returned"),
  identity: (target, create, signal) => profile.child(create ? "identity.create" : "identity.check", () => native.identity(target, create, signal), r => r ? "matched" : "missing"),
  close: () => native.close(),
};
const highlights = new WindowHighlights(async () => startOverlayPeer(await findWindowOverlay(), [], config.interop));
const observer = (frame, signal) => profile.child("overlay.flash", () => highlights.flash(frame, signal), r => r.status);
const session = new ComputerSession(decorated, () => "yolo", undefined, observer);
let fixture, site, completed = false, stage = "fixture_start", dimensions;
const fixedOptions = { hints: false, guides: { grid: false, region: false, action: false } };
const summaries = samples => {
  const labels = ["identity.check", "native.get_window_state", "overlay.flash"];
  const median = a => { const sorted = [...a].sort((a,b) => a-b); return sorted.length % 2 ? sorted[(sorted.length-1)/2] : (sorted[sorted.length/2-1]+sorted[sorted.length/2])/2; };
  return ["full", "image", "ui"].map(mode => {
    const group = samples.filter(s => s.phase === "warm" && s.operation === `observe.${mode}` && s.success);
    if (!group.length) return { mode, count: 0 };
    return { mode, count: group.length, median_ms: median(group.map(s => s.duration_ms)),
      stages: Object.fromEntries(labels.map(label => [label, {
        calls_per_observation: group.map(s => s.children.filter(c => c.name === label).length),
        median_sum_ms: median(group.map(s => s.children.filter(c => c.name === label).reduce((n,c) => n+c.duration_ms,0))),
      }])), adapter_remaining_median_ms: median(group.map(s => s.remaining_ms)) };
  });
};
try {
  site = await createUiResourcesSite();
  const root = path.dirname(config.command);
  assert.ok(root.startsWith("/mnt/c/"), "Use the unchanged trusted Windows runtime.");
  fixture = await openCompleteInputWindow(native, site.url, root.replace("/mnt/c/", "C:\\").replaceAll("/", "\\"));
  const listed = await session.windows(abort.signal);
  const owned = listed.details.state.windows.filter(w => w.pid === fixture.target.pid && w.window_id === fixture.target.window_id);
  assert.equal(owned.length, 1, "Require this exact owned fixture.");
  const window_ref = owned[0].window_ref;
  const call = async (mode, phase) => {
    stage = `observe.${mode}`;
    const result = await profile.operation(stage, phase, async () => {
      const r = await session.observe(window_ref, abort.signal, undefined, undefined, undefined,
        mode === "ui" ? { granularity: mode } : { granularity: mode, ...fixedOptions });
      return { ...r, status: r.details.status };
    }, "observed", async r => {
      assert.equal(r.details.granularity, mode);
      assert.equal(r.details.highlight?.status, "shown", "Keep the ordinary human frame enabled.");
      assert.equal(r.content.filter(c => c.type === "image").length, mode === "ui" ? 0 : 1);
      assert.equal(!!r.details.ui, mode !== "image");
      if (mode !== "ui") {
        const d = r.details.source.image.dimensions;
        if (!dimensions) dimensions = d;
        assert.deepEqual(d, dimensions, "Same-cap geometry changed.");
      }
    });
    return result;
  };
  const first = await call("full", "cold");
  await writeFile(`${directory}/owned-overview.png`, Buffer.from(first.content.find(c => c.type === "image").data, "base64"));
  await call("image", "setup"); await call("ui", "setup");
  for (let i = 0; i < repeats; i++) {
    if (abort.signal.aborted) throw Error("Cancelled");
    for (const mode of (i % 2 ? ["ui", "image", "full"] : ["full", "image", "ui"])) await call(mode, "warm");
  }
  assert.equal(site.events().length, 0, "Profiling observations must send no fixture input.");
  completed = true;
} catch { console.error(`Profile stopped at ${stage}; no input replay.`); }
finally {
  const cleanup = await finishProfile(completed, {
    fixture: async () => { if (!fixture) throw Error("Fixture ownership was not established."); const r = await fixture.close(); assert.ok(r.sourceGone && r.profileRemoved); },
    session: async () => { const r = await session.close(); assert.equal(r.details.status, "closed"); },
    overlay: () => highlights.close(),
    site: async () => { await site?.close(); },
  });
  const report = { schema: 1, ...cleanup, runtime: config.runtime, cap: 500, scale: 1, dimensions,
    boundary: "Real ComputerSession window observation. Native RPC includes Windows capture/encoding and IPC. Pi hooks, Codemode transport, model and TUI are excluded.",
    remaining: "Root minus union of identity, native RPC and overlay intervals; adapter/image metadata, annotation, projection and scheduling are not individually timed.",
    no_input_during_samples: completed, summary: summaries(profile.samples), samples: profile.samples };
  await writeFile(`${directory}/report.json`, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ success: report.success, cleanup: report.cleanup, summary: report.summary, report: `${directory}/report.json`, overview: `${directory}/owned-overview.png` }));
  if (!report.success) process.exitCode = 1;
  process.off("SIGINT", interrupt); process.off("SIGTERM", interrupt);
}
