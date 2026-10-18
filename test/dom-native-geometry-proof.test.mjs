import assert from "node:assert/strict";
import { test } from "node:test";
import { Script } from "node:vm";
import { setImmediate as nextTurn } from "node:timers/promises";
import { VIEWPORT_MARKERS, createViewportProofPage, validateViewportReport, assertViewportHistory } from "../scripts/fixtures/dom-viewport-proof-page.mjs";
import { verifyViewportRaster, validateNativeGeometry, assertGeometryContinuity, geometryDocumentIdentity, assertAddressBar, assertSetupReceipt, assertSelectedNativeWindow, establishNativeForeground, runNativeGeometryProof } from "../scripts/dom-native-geometry-proof.mjs";

function fixture(scrollY = 0) {
  const width=1330,height=949,rgba=new Uint8Array(width*height*4),frame={x:70,y:61,width,height};
  for(let i=0;i<rgba.length;i+=4){rgba[i]=128;rgba[i+1]=128;rgba[i+2]=128;rgba[i+3]=255;}
  const nativeViewport={x:71,y:191,width:1329,height:819},dpr=1.5;
  const samples=VIEWPORT_MARKERS.map(marker=>{
    const css={x:marker.x,y:marker.y-scrollY,width:marker.width,height:marker.height};
    const left=Math.floor(css.x*dpr),top=Math.floor(css.y*dpr),right=Math.ceil((css.x+css.width)*dpr),bottom=Math.ceil((css.y+css.height)*dpr);
    const screen={x:nativeViewport.x+left,y:nativeViewport.y+top,width:right-left,height:bottom-top};
    for(let y=screen.y-frame.y;y<screen.y-frame.y+screen.height;y++)for(let x=screen.x-frame.x;x<screen.x-frame.x+screen.width;x++){
      const offset=(y*width+x)*4;rgba[offset]=marker.rgb;rgba[offset+1]=marker.rgb;rgba[offset+2]=marker.rgb;
    }
    return{id:marker.id,css,screen};
  });
  return{rgba,width,height,nativeViewport,layout:{width:886,height:546,dpr},scroll:{x:0,y:scrollY},samples,
    capture:{capture_backend:{backend:"wgc",frame_bounds:frame},screenshot_width:width,screenshot_height:height,screenshot_original_width:width,screenshot_original_height:height}};
}

test("predeclared integral and fractional boxes pass at both fixed scroll stages",()=>{
  for(const scroll of [0,100]){
    const result=verifyViewportRaster(fixture(scroll));
    assert.equal(result.results.length,4);assert.equal(result.native_mapping_qualified,false);
    assert.deepEqual(result.results.map(x=>x.integral),[true,true,false,false]);
  }
});
test("a one-pixel origin error fails instead of fitting a nearby rectangle",()=>{
  const input=fixture();input.capture.capture_backend.frame_bounds.y++;
  assert.throws(()=>verifyViewportRaster(input),/mismatched declared interior/);
});
test("a one-pixel viewport mismatch, resampling or another capture route refuses",()=>{
  for(const change of [x=>x.nativeViewport.width++,x=>x.nativeViewport.height--,x=>x.capture.screenshot_original_width++,x=>x.capture.capture_backend.backend="default"]){
    const input=fixture();change(input);assert.throws(()=>verifyViewportRaster(input));
  }
});
test("reported mapping must equal the declared enclosing rule, including fractional edges",()=>{
  const input=fixture();input.samples[2].screen.x+=1;
  assert.throws(()=>verifyViewportRaster(input),/predeclared rule/);
});
test("fractional antialias boundary colors are not guessed, but their interior remains exact",()=>{
  const input=fixture(),sample=input.samples[2],frame=input.capture.capture_backend.frame_bounds;
  const edge=((sample.screen.y-frame.y)*input.width+sample.screen.x-frame.x)*4;
  input.rgba[edge]=96;input.rgba[edge+1]=96;input.rgba[edge+2]=96;
  assert.doesNotThrow(()=>verifyViewportRaster(input));
  const x=input.nativeViewport.x+Math.ceil(sample.css.x*1.5)-frame.x;
  const y=input.nativeViewport.y+Math.ceil(sample.css.y*1.5)-frame.y;
  input.rgba[(y*input.width+x)*4]=96;
  assert.throws(()=>verifyViewportRaster(input),/mismatched declared interior/);
});
test("paint beyond the declared enclosure, missing sources and changed CSS cannot pass",()=>{
  const outside=fixture(),sample=outside.samples[0],frame=outside.capture.capture_backend.frame_bounds;
  const offset=((sample.screen.y-frame.y-1)*outside.width+sample.screen.x-frame.x)*4;
  outside.rgba[offset]=0;outside.rgba[offset+1]=0;outside.rgba[offset+2]=0;
  assert.throws(()=>verifyViewportRaster(outside),/beyond its declared enclosure/);
  const missing=fixture();missing.samples.pop();assert.throws(()=>verifyViewportRaster(missing));
  const changed=fixture();changed.samples[0].css.y++;assert.throws(()=>verifyViewportRaster(changed));
});
test("the fixed fixture uses external JS and a fixed 60-second scroll",()=>{
  const {html,script}=createViewportProofPage("22222222-2222-4222-8222-222222222222");
  assert.match(html,/<script src="\/fixture.js"><\/script>/);
  assert.equal(html.includes("const nonce="),false);
  assert.doesNotThrow(()=>new Script(script));
  assert.throws(()=>createViewportProofPage("<script>"));
});

const nonce="22222222-2222-4222-8222-222222222222", url="http://127.0.0.1:12345/";
test("fixture timer reports exact stage-one scroll without input or caller code",async()=>{
 const timers=[],posted=[],listeners=new Map();
 const sandbox={crypto:{randomUUID:()=>nonce},innerWidth:886,innerHeight:546,devicePixelRatio:1.5,scrollX:0,scrollY:0,
  location:{href:url},visualViewport:{offsetLeft:0,offsetTop:0,pageLeft:0,pageTop:0,width:875.3333333333334,height:546,scale:1},
  document:{addEventListener:(type,fn)=>listeners.set(type,fn),getElementById:id=>({getBoundingClientRect:()=>{const m=VIEWPORT_MARKERS.find(x=>x.id===id);return{x:m.x,y:m.y-sandbox.scrollY,width:m.width,height:m.height};}})},
  scrollTo:(x,y)=>{sandbox.scrollX=x;sandbox.scrollY=y;sandbox.visualViewport.pageLeft=x;sandbox.visualViewport.pageTop=y;},
  fetch:async(path,request)=>{assert.equal(path,"/witness");posted.push(JSON.parse(request.body));},
  setInterval:fn=>{timers.push({interval:fn});return 1;},clearInterval:()=>{},setTimeout:(fn,ms)=>timers.push({fn,ms})};
 new Script(createViewportProofPage(nonce).script).runInNewContext(sandbox, {timeout:1000});
 await nextTurn();
 assert.equal(posted.length,1);validateViewportReport(posted[0],nonce,url);
 assert.deepEqual(timers.filter(x=>x.ms).map(x=>x.ms),[60000,120000]);
 timers.find(x=>x.ms===60000).fn();await nextTurn();
 assert.equal(posted.length,2);assert.equal(posted[1].stage,1);assert.equal(posted[1].viewport.scrollY,100);
 validateViewportReport(posted[1],nonce,url);assert.deepEqual(posted[1].events,[]);
});
function report(serial=1) {
 return {nonce,documentId:nonce,serial,stage:0,events:[{type:"pointerover",trusted:true}],overflow:false,location:url,
 viewport:{width:886,height:546,dpr:1.5,scrollX:0,scrollY:0,visual:{offset_x:0,offset_y:0,page_x:0,page_y:0,width:875.3333333333334,height:546,scale:1}},
 markers:VIEWPORT_MARKERS.map(m=>({id:m.id,bounds:{x:m.x,y:m.y,width:m.width,height:m.height}}))};
}
test("independent history preserves the nonempty setup prefix and refuses later input",()=>{
 const first={...report(),received_ms:1000}, second={...report(2),received_ms:1100};
 assertViewportHistory([first,second],nonce,url,0,{serial:1,events:first.events});
 second.events.push({type:"keydown",trusted:true});
 assert.throws(()=>assertViewportHistory([first,second],nonce,url,0,{serial:1,events:first.events}));
});
test("witness refuses erased prefixes, replacement, reordered serials, unknown fields and changed marker geometry",()=>{
 const first={...report(),received_ms:1000};
 for(const mutate of [r=>r.events=[],r=>r.documentId="33333333-3333-4333-8333-333333333333",r=>r.serial=1,r=>r.stage=1]){
  const next={...report(2),received_ms:1100};mutate(next);
  assert.throws(()=>assertViewportHistory([first,next],nonce,url,0));
 }
 for(const mutate of [r=>r.extra=true,r=>r.viewport.dpr=Infinity,r=>r.markers[0].bounds.x++,r=>r.events[0].extra=true,r=>r.overflow=true]){
  const next=report();mutate(next);assert.throws(()=>validateViewportReport(next,nonce,url));
 }
});
function receipt(id=0){
 const f=fixture(), sample=f.samples[id];
 return {format:"native_dom_geometry_v1",status:"ok",mode:"native_element_geometry",ref:`ref${id}`,source_ref:`ref${id}`,target_id:"target",tab_id:"tab",
 source:{frame_id:"F",loader_id:"L",backend_node_id:id+1,context_unique_id:"C",generation:1},frame:{kind:"main"},
 css_sample:{connected:true,same_document:true,bounds:sample.css,scroll:f.scroll,layout_viewport:f.layout,
 visual_viewport:{offset_x:0,offset_y:0,page_x:0,page_y:0,width:875.3333333333334,height:546,scale:1}},
 native:{platform:"windows",pid:1,window_id:2,window:{x:70,y:61,width:1330,height:949},viewport:f.nativeViewport,source:"uia_root_web_area",automation_id:"RootWebArea",framework:"Chrome",opaque_runtime_id:[42,7,1]},
 physical_enclosing_rect:sample.screen,clipped:false,coordinate_space:"screen_physical_pixels",browser_version:{product:"Chrome/145",revision:"@exact"},
 projection:"root_origin_plus_floor_start_ceil_end_at_sampled_dpr",qualification:"candidate_not_raster_qualified",atomic:false,input_authority:false};
}
const page={target_id:"target",tab_id:"tab"}, target={pid:1,window_id:2};
test("native receipts require attested DPR, closed fields, exact source and zero input authority",()=>{
 assert.doesNotThrow(()=>validateNativeGeometry(receipt(),{page,target,reference:"ref0",marker:VIEWPORT_MARKERS[0],witness:report()}));
 for(const mutate of [r=>r.native.viewport.width++,r=>r.css_sample.layout_viewport.dpr=1,r=>r.source.loader_id="",r=>r.source.extra=true,r=>r.input_authority=true,r=>r.physical_enclosing_rect.x++,r=>r.browser_version.revision="",r=>r.native.opaque_runtime_id=[]]){
  const r=receipt();mutate(r);assert.throws(()=>validateNativeGeometry(r,{page,target,reference:"ref0",marker:VIEWPORT_MARKERS[0],witness:report()}));
 }
});
test("qualified source continuity uses opaque runtime IDs and exact physical/native identity",()=>{
 const before=[receipt(0),receipt(1)];assert.doesNotThrow(()=>assertGeometryContinuity(before,structuredClone(before)));
 for(const mutate of [r=>r.native.opaque_runtime_id[0]++,r=>r.source.context_unique_id="changed",r=>r.native.window.x++,r=>r.css_sample.bounds.y++,r=>r.browser_version.revision="@changed"]){
  const after=structuredClone(before);mutate(after[0]);assert.throws(()=>assertGeometryContinuity(before,after));
 }
});
test("timer scroll changes CSS and refs but cannot change source/native identity",()=>{
 const before=[0,1,2,3].map(receipt),after=structuredClone(before);
 for(const r of after){r.ref="new-"+r.ref;r.source_ref=r.ref;r.css_sample.bounds.y-=100;}
 assert.deepEqual(geometryDocumentIdentity(before),geometryDocumentIdentity(after));
 after[0].source.loader_id="changed";assert.notDeepEqual(geometryDocumentIdentity(before),geometryDocumentIdentity(after));
});
test("CLI refuses unapproved, extra or nonqualified source arguments before loading native dependencies",async()=>{
 for(const args of [[],["--live-approved","ignored","9be71f07311b8c06ca5b13a75ea15214f838c56d"],["--not-approved","ignored","6c65c516c955ed2c6ef77bf74f48ceb1a44303de"],["--live-approved","ignored","6c65c516c955ed2c6ef77bf74f48ceb1a44303de","http://foreign/"]])await assert.rejects(()=>runNativeGeometryProof(args));
});
test("retired candidates cannot enter the combined proof before exact source admission",async()=>{
 for(const source of ["6c65c516c955ed2c6ef77bf74f48ceb1a44303de","dd885801273af80a55092292d31273124ba5b37a","68f5cce475af01aa4168e39de59e02e0b3b60554","9466c5bcce8d61e8bd5c64bd895b536944b51a8e"])
  await assert.rejects(()=>runNativeGeometryProof(["--live-approved","ignored",source]),/Only the reviewed strict-geometry source is admitted/);
});
test("fresh exact-window metadata may mint different IDs but cannot replace the retained document capability",()=>{
 const bound={status:"ok",mode:"bind",binding_quality:"exact",mutation_allowed:true,binding_route:"native_cdp_window",endpoint_access_class:"driver_owned",
  target_id:"fresh-diagnostic-target",tabs:[{tab_id:"fresh-diagnostic-tab",active:true,url,title:"Owned fixture"}]};
 const metadata=structuredClone(bound);
 assert.equal(assertSelectedNativeWindow(bound,url,"Owned fixture"),undefined);
 assert.deepEqual(bound,metadata);
 for(const mutate of [r=>r.mode="snapshot",r=>r.binding_quality="heuristic",r=>r.binding_route="title_only",r=>r.endpoint_access_class="existing_profile",r=>r.mutation_allowed=false,
  r=>r.tabs.push({...r.tabs[0]}),r=>r.tabs[0].active=false,r=>r.tabs[0].url="http://foreign/",r=>r.tabs[0].title="Other document",r=>r.target_id="",r=>r.tabs[0].tab_id=""]){
  const value=structuredClone(bound);mutate(value);assert.throws(()=>assertSelectedNativeWindow(value,url,"Owned fixture"));
 }
});
test("navigation requires exact native address-bar context and exact native acknowledgements without retry",()=>{
 const overview={elements:[{role:"Edit",label:"Address and search bar",value:url}]};
 assertAddressBar(overview,url);
 for(const state of [{elements:[]},{elements:[...overview.elements,...overview.elements]},{elements:[{...overview.elements[0],in_web_content:true}]},{elements:[{...overview.elements[0],value:"http://other/"}]}])assert.throws(()=>assertAddressBar(state,url));
 const control={pid:123,window_id:456,state_id:"ws-owned",state:{bounds:{x:1,y:2,width:100,height:80},bounds_source:"dwm_visible_frame",minimized:false,foreground_at_target:false,foreground_window:999,virtual_desktop:{on_current_desktop:true,desktop_id:"desktop"}}};
 const nativeFocus={structuredContent:{pid:123,window_id:456,state_id:"ws-owned",operation:"focus",requested_bounds:null,mutation_attempted:true,mutation_accepted:true,postcondition_confirmed:true,before:structuredClone(control.state),observed:{...structuredClone(control.state),foreground_at_target:true,foreground_window:456},route:"native",effect:"confirmed"}};
 const focusContext={kind:"native_focus",pid:123,windowId:456,control};
 assert.doesNotThrow(()=>assertSetupReceipt(nativeFocus,focusContext));
 for(const mutate of [r=>r.isError=true,r=>r.structuredContent.mutation_accepted=false,r=>r.structuredContent.postcondition_confirmed=false,r=>r.structuredContent.observed.foreground_at_target=false,r=>r.structuredContent.state_id="other",r=>r.structuredContent.window_id=789,r=>r.structuredContent.effect="unknown",r=>r.structuredContent.observed.bounds.width++,r=>r.structuredContent.observed.foreground_window=999,r=>r.structuredContent.before.foreground_window=456]){const r=structuredClone(nativeFocus);mutate(r);assert.throws(()=>assertSetupReceipt(r,focusContext));}
 assert.throws(()=>assertSetupReceipt(nativeFocus,{...focusContext,control:{...control,state:{...control.state,virtual_desktop:{on_current_desktop:null}}}}));
 const context={kind:"background",pid:123};
 const refused={isError:true,structuredContent:{code:"background_unavailable",event_kind:"key_combo",target_class:"Chrome_WidgetWin_1",suggestion:"explicit foreground",escalation:{recommended:"foreground",reason:"background unavailable"}}};
 assert.doesNotThrow(()=>assertSetupReceipt(refused,context));
 for(const mutate of [r=>r.isError=false,r=>r.structuredContent.code="foreground_unavailable",r=>r.structuredContent.event_kind="unknown",r=>r.structuredContent.target_class="other"]){const r=structuredClone(refused);mutate(r);assert.throws(()=>assertSetupReceipt(r,context));}
 const acknowledged=summary=>({content:[{type:"text",text:summary}],structuredContent:{delivery:{mode:"foreground"},effect:"unverifiable",route:"global_input",summary}});
 const hotkey=acknowledged("✅ Pressed ctrl+l on pid 123 via SendInput (Win32 target).");
 const typed=acknowledged(`✅ Typed ${url.length} char(s) on pid 123 via SendInput (delivery_mode:foreground).`);
 const returned=acknowledged("✅ Sent return via SendInput on pid 123 (delivery_mode:foreground).");
 for(const [r,c] of [[hotkey,{kind:"hotkey",pid:123}],[typed,{kind:"type_text",pid:123,text:url}],[returned,{kind:"press_key",pid:123}]]){
  assert.doesNotThrow(()=>assertSetupReceipt(r,c));
  assert.throws(()=>assertSetupReceipt({...r,isError:true},c));
  assert.throws(()=>assertSetupReceipt({...r,content:[{type:"text",text:"unknown/partial; do not replay"}]},c));
  assert.throws(()=>assertSetupReceipt(r,{...c,pid:124}));
 }
 for(const r of [{structuredContent:{effect:"unknown"}},{structuredContent:{status:"unknown"}}, {...typed,structuredContent:{path:"key_events",characters:url.length,effect:"confirmed"}}])assert.throws(()=>assertSetupReceipt(r,{kind:"type_text",pid:123,text:url}));
});

function focusCase() {
 const control={pid:123,window_id:456,state_id:"ws-once",state:{bounds:{x:1,y:2,width:100,height:80},bounds_source:"dwm_visible_frame",minimized:false,foreground_at_target:false,foreground_window:999,virtual_desktop:{on_current_desktop:true}}};
 const confirmed={structuredContent:{pid:123,window_id:456,state_id:"ws-once",operation:"focus",requested_bounds:null,mutation_attempted:true,mutation_accepted:true,postcondition_confirmed:true,before:structuredClone(control.state),observed:{...structuredClone(control.state),foreground_at_target:true,foreground_window:456},route:"native",effect:"confirmed"}};
 const after={...structuredClone(control),state_id:"ws-new",state:{...structuredClone(control.state),foreground_at_target:true,foreground_window:456}};
 return {control,confirmed,after,target:{pid:123,window_id:456}};
}

test("unknown native focus preserves its prefix and permits only outer cleanup, never later setup",async()=>{
 for(const rejectedPromise of [false,true]){
  const f=focusCase(),calls=[],unknown={isError:true,structuredContent:{code:"foreground_unavailable",status:"unknown",mutation_attempted:true,mutation_accepted:false,postcondition_confirmed:false}};
  const retained=structuredClone(unknown);
  const state=async(label,name,args)=>{calls.push(name);assert.deepEqual(args,f.target);return f.control;};
  const call=async(label,name,args)=>{calls.push(name);assert.deepEqual(args,{...f.target,state_id:"ws-once",operation:"focus"});if(rejectedPromise)throw Error("unknown native reply");return unknown;};
  await assert.rejects(async()=>{try{await establishNativeForeground({state,call},f.target);calls.push("hotkey-or-capture");}finally{calls.push("end_session");}});
  assert.deepEqual(calls,["get_window_control_state","manage_window","end_session"]);
  assert.deepEqual(unknown,retained);
 }
});

test("unproven focus admission stops before mutation and does not mint another token",async()=>{
 for(const mutate of [c=>c.state.virtual_desktop.on_current_desktop=null,c=>c.state.virtual_desktop.on_current_desktop=false,c=>c.window_id++,c=>c.state.minimized=true,c=>c.state_id="",c=>c.state_id=" \t ",c=>c.state.foreground_at_target=true,c=>delete c.state.foreground_window]){
  const f=focusCase(),calls=[];mutate(f.control);
  const state=async()=>{calls.push("state");return f.control;};
  const call=async()=>{calls.push("mutation");throw Error("must not dispatch");};
  await assert.rejects(()=>establishNativeForeground({state,call},f.target));
  assert.deepEqual(calls,["state"]);
 }
});

test("focus confirmation needs an independent exact-source foreground post-state",async()=>{
 for(const mutate of [null,c=>c.window_id++,c=>c.state.foreground_at_target=false,c=>c.state.bounds.width++,c=>c.state.virtual_desktop.on_current_desktop=null,c=>c.state.foreground_window=999]){
  const f=focusCase(),calls=[];if(mutate)mutate(f.after);
  const state=async()=>{calls.push("state");return calls.length===1?f.control:f.after;};
  const call=async()=>{calls.push("focus");return f.confirmed;};
  if(mutate)await assert.rejects(()=>establishNativeForeground({state,call},f.target));
  else await establishNativeForeground({state,call},f.target);
  assert.deepEqual(calls,["state","focus","state"]);
 }
});