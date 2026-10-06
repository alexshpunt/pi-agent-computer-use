import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { ComputerSession } from "../src/session.ts";
import { McpDriver } from "../src/driver.ts";
import { loadComputerConfig } from "../src/config.ts";

// Native mapping qualification, not a model score. Input stays inside newly owned fixtures.
assert.ok(process.argv.includes("--native"), "Pass --native to authorize owned fixture input.");
const directory = `.tmp/coordinate-annotations/native-${Date.now()}`;
await mkdir(directory, { recursive: true });
const config = await loadComputerConfig(process.cwd());
const records = [], cleanups = [];
let success = false;
function position(target, x, y, width, height) {
  const source = `Add-Type 'using System;using System.Runtime.InteropServices;public class CoordinateFixture {
[DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr c);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);
[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h,IntPtr a,int x,int y,int w,int t,uint f); }';
if([CoordinateFixture]::SetThreadDpiAwarenessContext([IntPtr](-4))-eq[IntPtr]::Zero){throw 'Physical fixture coordinates required'};
[uint32]$p=0;[void][CoordinateFixture]::GetWindowThreadProcessId([IntPtr]${target.window_id},[ref]$p);
if($p-ne${target.pid}){throw 'Owned fixture identity changed'};
if(-not[CoordinateFixture]::SetWindowPos([IntPtr]${target.window_id},[IntPtr]::Zero,${x},${y},${width},${height},20)){throw 'Fixture positioning failed'};`;
  execFileSync("/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(source,"utf16le").toString("base64")],
    {stdio:["ignore","pipe","pipe"],timeout:10000});
}
async function events(info) {
  if (info.url) return (await fetch(new URL("events",info.url))).json();
  return (await readFile(`${info.nativeDirectory}/native-events.jsonl`,"utf8").catch(()=>""))
    .trim().split("\n").filter(Boolean).map(line=>JSON.parse(line));
}
try {
  for (const mode of ["native","browser"]) {
    const child = spawn(process.execPath,["--experimental-transform-types","scripts/ui-resources-fixture.mjs",mode],{stdio:["pipe","pipe","inherit"]});
    const lines = createInterface({input:child.stdout});
    const exited = new Promise(resolve=>child.once("exit",(code)=>resolve(code)));
    let info, session;
    try {
      for await (const line of lines) { if(line.startsWith('{"directory":')) { info=JSON.parse(line); break; } }
      assert.ok(info?.target,"Owned fixture did not become ready; do not relaunch blindly.");
      let cap = 500;
      session = new ComputerSession(new McpDriver(config),undefined,()=>({maxLongEdge:cap,scale:1,hints:true,guides:{grid:true,region:true,action:true}}));
      const listed = await session.windows();
      const windows = listed.details.state.windows.filter(w=>w.pid===info.target.pid&&w.window_id===info.target.window_id);
      assert.equal(windows.length,1); const ref=windows[0].window_ref;
      for (const [caseName, geometry] of [["baseline",[40,50,1600,1200]],["move",[180,140,1600,1200]],["resize",[180,140,1760,1320]]]) {
        position(info.target,...geometry); await delay(200);
        for (cap of [500,800,1024]) {
          let view=await session.observe(ref);
          assert.equal(view.details.status,"observed",view.content[0]?.text);
          await writeFile(`${directory}/${mode}-${caseName}-${cap}-ui.json`,JSON.stringify(view.details.ui,null,2));
          const label=mode==="native"?"Coordinate target":"Canvas";
          const candidates=view.details.ui.elements.filter(e=>e.name===label&&e.enabled!==false&&e.bounds.window_image);
          assert.equal(candidates.length,1,"Require the observed disposable Canvas target.");
          const target=candidates[0], r=target.bounds.window_image;
          const point={x:r.x+r.width/2,y:r.y+r.height/2};
          const before=(await events(info)).length;
          let result=await session.act({window_ref:ref,observation_id:view.details.observation_id,action:"click",...point});
          if(result.details.status==="refused"&&result.details.state?.code==="background_unavailable") {
            view=await session.observe(ref);
            const fresh=view.details.ui.elements.find(e=>e.name===label&&e.bounds.native_screen?.x===target.bounds.native_screen.x);
            assert.deepEqual(fresh?.bounds.window_image,r,"Changed target after refusal; do not reuse its point.");
            result=await session.act({window_ref:ref,observation_id:view.details.observation_id,action:"click",delivery_mode:"foreground",...point});
          }
          assert.equal(result.details.status,"delivered",JSON.stringify(result.details));
          const row={mode,case:caseName,cap,dimensions:view.details.source.image.dimensions,point,coordinate_grounding:result.details.state?.coordinate_grounding}; records.push(row);
          let pointer;
          for(let i=0;i<30;i++) { pointer=(await events(info)).slice(before).find(e=>(e.kind??e.type)==="pointer"); if(pointer) break; await delay(50); }
          assert.ok(pointer,"No native app pointer witness; input was not replayed.");
          const p=pointer.value;
          const dx=p.x-p.center_x,dy=p.y-p.center_y;
          // Nearest overview center carries up to one rescaled pixel plus native integer rounding.
          const frame=target.bounds.native_screen;
          const scale=frame.width/r.width/(mode==="browser"?p.dpr:1);
          const tolerance=Math.ceil(scale)+1;
          assert.ok(Math.abs(dx)<=tolerance&&Math.abs(dy)<=tolerance,`Hit error ${dx},${dy} exceeds ${tolerance} ${mode==="browser"?"CSS":"native"} pixels.`);
          assert.ok((await events(info)).slice(before).some(e=>(e.kind??e.type)==="click"),"Require actual application click effect.");
          const after=await session.observe(ref); const png=after.content.find(c=>c.type==="image");
          await writeFile(`${directory}/${mode}-${caseName}-${cap}.png`,Buffer.from(png.data,"base64"));
          Object.assign(row,{domain:mode==="browser"?"app_client_css_pixels":"native_screen_pixels",dx,dy,tolerance,dpi:p.dpi??null,dpr:p.dpr??null,
            annotation:after.details.agent_image.annotation});
        }
      }
    } finally {
      await session?.close(); child.stdin.end("finish\n"); lines.close();
      assert.equal(await exited,0,"Owned fixture cleanup failed.");
      if(info) { const run=JSON.parse(await readFile(`${info.directory}/run.json`,"utf8")); cleanups.push({mode,...run.cleanup}); }
    }
  }
  success=true;
} finally { await writeFile(`${directory}/run.json`,JSON.stringify({success,records,cleanups},null,2)); }
console.log(JSON.stringify({success,directory,hits:records.length,cleanups}));
