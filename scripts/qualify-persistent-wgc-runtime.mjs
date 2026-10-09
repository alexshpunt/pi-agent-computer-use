import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { loadComputerConfig } from "../src/config.ts";
import { McpDriver } from "../src/driver.ts";
import { createPersistentWgcSite } from "../test/fixtures/persistent-wgc-site.ts";
import { inspectMarkerPixels } from "./inspect-marker-pixels.ts";
import { openCompleteInputWindow } from "./complete-input-window.mjs";

// Qualify only two newly created disposable fixtures with the task's separate checked runtime.
assert.equal(process.argv[2], "--owned-fixtures");
const config = await loadComputerConfig(process.cwd());
assert.equal(config.runtime, "windows-persistent-wgc");
assert.ok(config.command.startsWith("/mnt/c/"));
const mainConfig = "/root/dev/pi/pi-agent-computer-use/.pi/computer-use.json";
const installedBefore = await readFile(mainConfig);
const run = path.resolve(`.tmp/wgc-integration/native-${Date.now()}`);
await mkdir(run, { recursive:true });
const windows = value => "C:\\" + value.slice(7).replaceAll("/", "\\");
const report = { schema:1, success:false, input_attempts:0, samples:[], checks:[], cleanup:{},
  boundary:"Native MCP wall time excludes independent PNG inspection and evidence saving. Current pixels are verified separately; timestamps do not prove freshness. No installed runtime/config changes.",
  deadline_ms:180000 };
const deadline = Date.now() + report.deadline_ms;
const drivers = [new McpDriver(config),new McpDriver(config)];
const sites = [], fixtures = [];
let reads = 0;
const guard = () => assert.ok(Date.now() < deadline && reads < 120, "Qualification budget exhausted");
const check = (name, fields={}) => report.checks.push({ check:name, passed:true, ...fields });
const view = async (index, backend, mode="image") => {
  guard(); reads++;
  const start = performance.now();
  const result = await drivers[index].call("get_window_state", { ...fixtures[index].target,
    ...(backend === "wgc" ? { capture_backend:"wgc" } : {}),
    ...(mode === "image" ? { include_accessibility_tree:false } : {}),
    ...(mode === "ui" ? { include_screenshot:false } : { max_image_dimension:500 }) });
  const wall = performance.now() - start;
  assert.ok(!result.isError && !result.structuredContent?.screenshot_error, "Native capture refused; stop without replay");
  const state = result.structuredContent;
  assert.ok(state, "Missing native state");
  if (mode === "ui") {
    assert.equal(result.content.some(block => block.type === "image"), false);
    return { state, wall };
  }
  const images = result.content.filter(block => block.type === "image");
  assert.equal(images.length,1); assert.equal(images[0].mimeType,"image/png");
  if (backend === "wgc") {
    assert.equal(state.capture_backend?.backend,"wgc");
    assert.equal(state.capture_backend?.paint_freshness,"unverified");
    assert.ok(typeof state.capture_id === "string" && state.capture_id.length > 0);
  }
  return { state, wall, png:Buffer.from(images[0].data,"base64") };
};
const current = async (index, backend, phase, mode="image") => {
  const desired = sites[index].state();
  const started = performance.now();
  for (let n=1;n<=6;n++) {
    const sample = await view(index,backend,mode);
    const pixels = await inspectMarkerPixels(sample.png, desired.color);
    const row = { owner:index, backend, phase, mode, native_rpc_ms:sample.wall,
      reads_to_current:n, publication_to_current_ms:performance.now()-started,
      ...pixels, capture:sample.state.capture_backend ?? null,
      native_width:sample.state.screenshot_original_width ?? null,
      native_height:sample.state.screenshot_original_height ?? null,
      png_sha256:createHash("sha256").update(sample.png).digest("hex"), verified:pixels.matching_pixels>=40 };
    report.samples.push(row);
    if (row.verified) {
      await writeFile(path.join(run,`${report.samples.length}-${phase}-${backend}.png`),sample.png);
      return sample;
    }
    // This is a new read of known fixture pixels, not a retry of input or a failed native call.
  }
  throw Error("Current fixture revision absent within six successful image reads");
};
try {
  for (let index=0;index<2;index++) {
    const site = await createPersistentWgcSite(); sites.push(site);
    if(index) for(let n=0;n<12;n++) site.advance();
    const fixture = await openCompleteInputWindow(drivers[index],site.url,windows(path.dirname(config.command)),
      ["--force-color-profile=srgb","--window-size=1050,750"]);
    fixtures.push(fixture);
  }
  for (let index=0;index<2;index++) {
    await current(index,"default","default");
    const cold = await current(index,"wgc","cold");
    assert.equal(cold.state.capture_backend.resources_reused,false);
  }
  check("default_and_cold_current_pixels_two_owners");
  for (let n=0;n<5;n++) {
    sites[0].advance();
    const sample = await current(0,"wgc","warm", n%2 ? "full" : "image");
    assert.equal(sample.state.capture_backend.resources_reused,true);
    assert.equal(sample.state.capture_backend.setup_ms,0);
  }
  check("warm_image_and_full_reuse_resources");
  await delay(5500);
  const afterIdle = await current(0,"wgc","after_idle");
  assert.equal(afterIdle.state.capture_backend.resources_reused,false);
  assert.ok(afterIdle.state.capture_backend.setup_ms>0);
  check("idle_resource_expiry_recreates_native_capture");
  await view(0,"default","ui"); check("ui_only_returns_no_pixels");
  const base = (await view(0,"wgc")).state.window_bounds;
  assert.ok(base && base.width > 0 && base.height > 0);
  const topology = await drivers[0].call("list_displays",{});
  assert.ok(!topology.isError,"Display metadata refused");
  const cx = base.x+base.width/2, cy = base.y+base.height/2;
  const monitor = topology.structuredContent?.displays.find(d=>cx>=d.bounds.x && cx<d.bounds.x+d.bounds.width && cy>=d.bounds.y && cy<d.bounds.y+d.bounds.height);
  assert.ok(monitor && base.width+60<monitor.bounds.width && base.height+60<monitor.bounds.height,"Fixture needs room on its current monitor");
  const moved = { ...base,x:monitor.bounds.x+30,y:monitor.bounds.y+30 };
  for(const [phase,frame] of [
    ["move",moved],
    ["shrink",{...moved,width:Math.floor(base.width*.8),height:Math.floor(base.height*.8)}],
    ["grow",base],
  ]) {
    guard();
    const changed = await drivers[0].call("set_window_frame",{...fixtures[0].target,...frame});
    assert.ok(!changed.isError,"Owned frame change refused; no replay");
    sites[0].advance();
    const sample = await current(0,"wgc",phase);
    const bounds = sample.state.window_bounds;
    assert.ok(Math.abs(bounds.width-frame.width)<=1 && Math.abs(bounds.height-frame.height)<=1);
    assert.equal(sample.state.capture_backend.resources_reused,true);
    check("current_pixels_and_native_dimensions_"+phase);
  }
  const placed = await drivers[1].call("set_window_frame",{...fixtures[1].target,...base});
  assert.ok(!placed.isError,"Own cover placement refused");
  const cover = await drivers[1].call("bring_to_front",fixtures[1].target);
  assert.ok(!cover.isError,"Own cover raise refused; no replay");
  const covered = await current(0,"wgc","covered");
  assert.equal((await inspectMarkerPixels(covered.png,sites[0].state().color,sites[1].state().color)).previous_matching_pixels,0);
  check("own_cover_does_not_replace_target_pixels");
  const target = await drivers[0].call("bring_to_front",fixtures[0].target);
  assert.ok(!target.isError,"Own target raise refused; no replay");
  const clickView = await current(0,"wgc","pixel_input","full");
  const buttons = clickView.state.elements.filter(e => e.label === "Save WGC fixture" && e.screenshot_frame && e.element_token);
  assert.equal(buttons.length,1);
  const frame = buttons[0].screenshot_frame;
  report.input_attempts++;
  const click = await drivers[0].call("click",{target:{kind:"window",...fixtures[0].target},
    x:frame.x+frame.w/2,y:frame.y+frame.h/2,capture_id:clickView.state.capture_id,delivery_mode:"background"});
  assert.ok(!click.isError && !["refused","unknown","partial"].includes(click.structuredContent?.effect) &&
    !["refused","unknown","partial"].includes(click.structuredContent?.status), "Input uncertain/refused; no replay");
  for(let n=0;n<10 && sites[0].events().filter(e=>e.type==="click").length===0;n++) await delay(20);
  assert.equal(sites[0].events().filter(e=>e.type==="click" && e.count===1).length,1);
  assert.equal(sites[0].events().filter(e=>e.type==="pointerdown").length,1);
  check("one_capture_bound_pixel_click_and_independent_pointer_click_witness");
  const controls = (await view(0,"default","full")).state.elements;
  const minimize = controls.filter(e=>e.label==="Minimize" && e.element_token);
  assert.equal(minimize.length,1);
  report.input_attempts++;
  const minimized = await drivers[0].call("click",{target:{kind:"window",...fixtures[0].target},element_token:minimize[0].element_token,delivery_mode:"background"});
  assert.ok(!minimized.isError && !["refused","unknown","partial"].includes(minimized.structuredContent?.effect) &&
    !["refused","unknown","partial"].includes(minimized.structuredContent?.status),"Minimize uncertain/refused; no replay");
  const unavailable = await drivers[0].call("get_window_state",{...fixtures[0].target,capture_backend:"wgc",include_accessibility_tree:false});
  assert.ok(unavailable.isError || unavailable.structuredContent?.screenshot_error);
  assert.equal(unavailable.content.some(block=>block.type==="image"),false);
  check("minimized_target_refuses_without_substitute_pixels");
  const restored = await drivers[0].call("bring_to_front",fixtures[0].target);
  assert.ok(!restored.isError,"Own minimized target restore refused");
  await current(0,"wgc","restored");
  await drivers[0].close();
  sites[1].advance();
  await current(1,"wgc","other_owner_after_close");
  check("closing_one_owner_keeps_other_current");
  const closedTarget = { ...fixtures[1].target };
  const closed = await fixtures[1].close(); fixtures[1] = undefined;
  assert.equal(closed.sourceGone,true); assert.equal(closed.profileRemoved,true);
  report.cleanup.fixture_1 = closed;
  const lost = await drivers[1].call("get_window_state",{...closedTarget,capture_backend:"wgc",include_accessibility_tree:false});
  assert.ok(lost.isError || lost.structuredContent?.code, "Closed target must refuse");
  check("closed_target_refuses_without_pixels");
  assert.equal(lost.content.some(block=>block.type==="image"),false);
  report.success = true;
} catch(error) {
  report.failure = error instanceof Error ? error.message.slice(0,500) : "Qualification failed";
  console.error("Persistent WGC qualification stopped; no failed request or input replay.");
} finally {
  // The fixture helper retains its creating peer; reconnecting that same object permits owned cleanup.
  for(let index=fixtures.length-1;index>=0;index--) if(fixtures[index]) {
    try {const result=await fixtures[index].close();report.cleanup[`fixture_${index}`]=result;} catch {report.cleanup[`fixture_${index}`]=false;report.success=false;}
  }
  for(let index=0;index<drivers.length;index++) {
    try {await drivers[index].close();report.cleanup[`driver_${index}`]=true;} catch {report.cleanup[`driver_${index}`]=false;report.success=false;}
  }
  for(let index=0;index<sites.length;index++) {
    try {await sites[index].close();report.cleanup[`site_${index}`]=true;} catch {report.cleanup[`site_${index}`]=false;report.success=false;}
  }
  report.installed_unchanged = installedBefore.equals(await readFile(mainConfig));
  report.reads = reads;
  report.success &&= report.installed_unchanged;
  await writeFile(path.join(run,"report.json"),JSON.stringify(report,null,2)+"\n");
  console.log(JSON.stringify({success:report.success,reads,checks:report.checks,cleanup:report.cleanup,installed_unchanged:report.installed_unchanged,report:path.join(run,"report.json")}));
  if(!report.success)process.exitCode=1;
}
