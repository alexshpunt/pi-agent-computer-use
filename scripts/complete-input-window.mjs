import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

/** Launch an isolated disposable Chrome through public CUA app tools, with renderer accessibility enabled. */
export async function openCompleteInputWindow(driver, url, nativeRoot) {
  const listed=await driver.call("list_apps",{});
  const chrome=listed.structuredContent?.apps.filter(app=>app.name==="Google Chrome"&&app.launch_path);
  assert.equal(chrome?.length,1,"Find one exact installed Google Chrome app.");
  assert.ok(nativeRoot.startsWith("C:\\"),"Use the trusted Windows runtime's parent directory.");
  const profile=`${nativeRoot}\\.tmp\\cua-gestures-${Date.now()}`;
  const before=await driver.call("list_windows",{});const known=new Set(before.structuredContent.windows.map(w=>`${w.pid}:${w.window_id}`));
  const launched=await driver.call("launch_app",{launch_path:chrome[0].launch_path,additional_arguments:[
    `--user-data-dir=${profile}`,"--no-first-run","--no-default-browser-check","--new-window","--force-renderer-accessibility",url,
  ]});
  assert.ok(!launched.isError,JSON.stringify(launched.structuredContent));
  const pid=launched.structuredContent?.pid;assert.ok(Number.isSafeInteger(pid)&&pid>0,"Launch must return an owned PID.");
  let target;
  for(let n=0;n<30;n++) {
    const found=await driver.call("list_windows",{});
    const rows=found.structuredContent.windows.filter(w=>w.pid===pid&&!known.has(`${w.pid}:${w.window_id}`));
    if(rows.length===1){target={pid,window_id:rows[0].window_id};break;}await delay(100);
  }
  // The unique profile cannot route into the user's existing browser.
  const close=async()=>{
    if(target) {
      const view=await driver.call("get_window_state",{...target,max_image_dimension:500});
      const closeButtons=(view.structuredContent?.elements??[]).filter(e=>e.label==="Close"&&e.screenshot_frame);
      const closeButton=closeButtons.sort((a,b)=>b.screenshot_frame.x-a.screenshot_frame.x)[0];
      if(closeButton) await driver.call("click",{target:{kind:"window",...target},element_token:closeButton.element_token,delivery_mode:"background"});
    }
    let sourceGone=false;
    for(let n=0;n<30;n++){const found=await driver.call("list_windows",{});sourceGone=!found.structuredContent.windows.some(w=>w.pid===pid);if(sourceGone)break;await delay(100);}
    if(!sourceGone) {
      const result=await driver.call("kill_app",{pid});assert.ok(!result.isError,JSON.stringify(result.structuredContent));
      const found=await driver.call("list_windows",{});sourceGone=!found.structuredContent.windows.some(w=>w.pid===pid);
    }
    assert.equal(sourceGone,true,"Owned browser window still present.");
    await rm(profile.replace("C:\\","/mnt/c/").replaceAll("\\","/"),{recursive:true,force:true,maxRetries:10,retryDelay:100});
    return {sourceGone,profileRemoved:true};
  };
  if(!target){await close();throw Error("No unique new browser window; launch was not repeated.");}
  return {target,profile,close};
}
