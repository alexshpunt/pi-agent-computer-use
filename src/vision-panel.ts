/** Static viewer. All observed text goes through textContent, never HTML evaluation. */
export const visionPanel = `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Pi vision debug</title>
<link rel="stylesheet" href="style.css">
<main>
<header><div><p class="eyebrow">PI · COMPUTER USE</p><h1>Vision debug</h1></div><span id="connection">Connecting…</span></header>
<p class="notice"><strong>Final delivery is unconfirmed.</strong> These are exact image bytes at Pi's existing application-boundary hook, not confirmed wire payloads or model embeddings.</p>
<p id="session"></p>
<section class="controls"><h2>Agent image size</h2>
<p class="muted" id="route-note">Native CUA window/display PNG overviews; browser captures include chrome. Lanczos3 is fixed, default long edge 500px. Window detail is fresh padded JPEG; display detail crops fresh full-resolution CUA pixels in the adapter. No retained originals. These controls apply to the next overview, not per-request detail settings.</p>
<form id="image-settings">
<label>Driver kernel <select id="kernel" disabled><option value="lanczos3" selected>Lanczos3</option></select></label>
<label>Max long edge (px) <input id="long-edge" type="text" inputmode="numeric" pattern="[0-9]+" value="500" required></label>
<label>Scale slider <input id="scale" type="range" min="0.05" max="1" step="any" value="1"><output id="scale-value">1</output></label>
<label>Scale exact <input id="scale-number" type="text" inputmode="decimal" value="1" required></label>
<button type="submit">Apply to next capture</button>
</form><p id="settings-status" role="status"></p></section>
<section><h2>Last three boundary images</h2><p class="muted">Oldest → newest. The viewer does not change the model's image budget.</p><div id="frames" class="frames"></div></section>
<section><h2>Observed request text</h2><p class="muted">Exact bounded text excerpts at the same hook. Adapter structures below are separate, not proof of forwarded content.</p><div id="request"></div></section>
<section><h2>Computer-use action trace</h2><p class="muted">Includes nested Codemode calls, captured-only images, errors and adapter metadata.</p><div id="actions"></div></section>
<section><h2>Limits</h2><ul id="limits"></ul></section>
</main><script src="panel.js"></script></html>`;

export const visionStyle = `
:root{color-scheme:dark;font:15px/1.5 system-ui;background:#111722;color:#e6edf7}
*{box-sizing:border-box}body{margin:0}main{max-width:1480px;margin:auto;padding:28px}
header{display:flex;justify-content:space-between;align-items:center;gap:16px}h1{margin:0;font-size:30px}
h2{font-size:21px;margin:0 0 8px}.eyebrow{letter-spacing:.13em;color:#7db9ff;margin:0;font-size:12px}
section{margin-top:30px}.notice{background:#332b17;border:1px solid #716033;padding:14px;border-radius:9px}
.controls form{display:flex;gap:20px;flex-wrap:wrap;align-items:end}.controls label{display:flex;flex-direction:column;gap:6px}select,input,button{font:inherit;color:inherit;background:#1b2432;border:1px solid #566b89;border-radius:6px;padding:8px}input[type=range]{padding:0;width:220px}button{cursor:pointer;background:#24446b}#settings-status{color:#a9d6b7}
.muted,#session,#connection{color:#aebbd0}.frames{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}
.card,details{background:#1b2432;border:1px solid #344258;border-radius:10px;padding:14px;min-width:0}
.card img{display:block;width:100%;height:230px;object-fit:contain;background:#0c111a;margin:12px 0}
.card h3{margin:0;font-size:16px}.meta{font:12px/1.6 ui-monospace,monospace;overflow-wrap:anywhere}
pre{font:12px/1.5 ui-monospace,monospace;white-space:pre-wrap;overflow-wrap:anywhere;max-height:400px;overflow:auto}
details{margin:10px 0}summary{cursor:pointer}.error{border-color:#d56b75}.empty{padding:28px;color:#aebbd0;border:1px dashed #344258;border-radius:8px}
@media(max-width:850px){.frames{grid-template-columns:1fr}.card img{height:280px}main{padding:18px}header{align-items:flex-start}}
`;

export const visionScript = `
const el=(tag,text,cls)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(cls)node.className=cls;return node};
let revision=-1,session,settingsVersion=-1,settingsDirty=false,settingsBusy=false,controlsReady=false;
function settingsDraft(){
  return {kernel:document.getElementById("kernel").value,maxLongEdge:Number(document.getElementById("long-edge").value),scale:Number(document.getElementById("scale-number").value)};
}
function showDraft(){
  const draft=settingsDraft();
  document.getElementById("scale-value").textContent=String(draft.scale);
  document.getElementById("settings-status").textContent="Draft cap: "+Math.floor(draft.maxLongEdge*draft.scale)+" px · apply to the next capture.";
}
function setupSettings(){
  for(const id of ["kernel","long-edge"])document.getElementById(id).addEventListener("input",()=>{settingsDirty=true;showDraft()});
  for(const [id,other] of [["scale","scale-number"],["scale-number","scale"]])document.getElementById(id).addEventListener("input",()=>{document.getElementById(other).value=document.getElementById(id).value;settingsDirty=true;showDraft()});
  document.getElementById("image-settings").addEventListener("submit",async event=>{
    event.preventDefault();if(settingsBusy)return;settingsBusy=true;
    const submitted=settingsDraft();
    try{
      const response=await fetch("settings",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(submitted)});
      if(!response.ok)throw Error(await response.text());
      const applied=await response.json();
      settingsDirty=JSON.stringify(settingsDraft())!==JSON.stringify(submitted);
      document.getElementById("settings-status").textContent="Applied v"+applied.version+": "+applied.kernel+" · cap "+Math.floor(applied.maxLongEdge*applied.scale)+" px · next capture.";
      settingsVersion=-1;
    }catch(error){document.getElementById("settings-status").textContent="Not applied: "+error.message}
    finally{settingsBusy=false}
  });
}
function renderSettings(settings){
  if(!settings)return;
  if(!settingsDirty&&!settingsBusy){
    document.getElementById("kernel").value=settings.kernel;
    document.getElementById("long-edge").value=String(settings.maxLongEdge);
    document.getElementById("scale").value=String(settings.scale);
    document.getElementById("scale-number").value=String(settings.scale);
    document.getElementById("scale-value").textContent=String(settings.scale);
    document.getElementById("settings-status").textContent="Active v"+settings.version+": "+settings.kernel+" · "+settings.maxLongEdge+" × "+settings.scale+" = cap "+Math.floor(settings.maxLongEdge*settings.scale)+" px. No upsampling.";
  }
}
function render(state){
  renderSettings(state.imageSettings);
  document.getElementById("session").textContent="Session "+state.sessionId+" · revision "+state.revision;
  const frames=document.getElementById("frames");frames.replaceChildren();
  for(const [i,frame] of state.frames.entries()){
    const card=el("article",undefined,"card");
    card.append(el("h3","t"+(i-state.frames.length+1)+" · "+frame.stage));
    if(frame.stage!=="evicted"){const img=el("img");img.src="images/"+frame.hash;img.alt="Application-boundary frame "+frame.id;card.append(img)}
    card.append(el("p",frame.time+" · "+(frame.width??"?")+"×"+(frame.height??"?")+" · "+frame.bytes+" bytes","meta"));
    card.append(el("p","Request "+frame.requestId+" · action "+(frame.actionId??"unmatched"),"meta"));
    card.append(el("p","SHA-256 "+frame.hash,"meta"));
    card.append(el("p","Native CUA capture or marked adapter output; no full-resolution original is retained.","muted"));
    card.append(el("pre",JSON.stringify({path:frame.path,detail:frame.detail,source:frame.source,matchingActionIds:frame.matchingActionIds,configuration:frame.configuration,finalDelivery:frame.finalDelivery},null,2)));
    frames.append(card);
  }
  if(!state.frames.length)frames.append(el("p","No boundary images yet. Captured-only frames do not appear here.","empty"));
  const request=document.getElementById("request");request.replaceChildren();
  const latest=state.requests.at(-1);
  if(latest){
    request.append(el("p",latest.id+" · "+latest.provider+"/"+latest.model+" · "+latest.imageCount+" image blocks · response "+(latest.responseStatus??"unobserved")+" · final payload unconfirmed","meta"));
    request.append(el("p",latest.textTruncated?"Text excerpts are truncated.":"Retained text blocks: "+latest.texts.length,"muted"));
    request.append(el("pre",latest.texts.map(item=>item.path+"\\n"+item.text).join("\\n\\n")));
  }else request.append(el("p","No request observed yet.","empty"));
  const actions=document.getElementById("actions");
  const existing=new Map([...actions.children].map(item=>[item.dataset.actionId,item]));
  const rows=[];
  for(const action of [...state.actions].reverse()){
    const captures=state.captures.filter(frame=>frame.actionId===action.id);
    const signature=JSON.stringify({action,captures});
    const previous=existing.get(action.id);
    if(previous?.dataset.signature===signature){rows.push(previous);continue}
    const item=el("details",undefined,action.isError?"error":"");
    item.dataset.actionId=action.id;item.dataset.signature=signature;item.open=previous?.open??false;
    item.append(el("summary",action.tool+" · "+action.status+" · "+(action.durationMs===undefined?"running":action.durationMs.toFixed(1)+" ms")+" · "+action.id));
    item.append(el("pre",JSON.stringify(action,null,2)));
    for(const capture of captures){
      item.append(el("p","Adapter image "+capture.hash+" · "+capture.stage+" · delivery unconfirmed","meta"));
      if(capture.stage!=="evicted"){const link=el("a","Open adapter image");link.href="images/"+capture.hash;link.target="_blank";link.rel="noopener";item.append(link)}
    }
    rows.push(item);
  }
  actions.replaceChildren(...rows);
  if(!state.actions.length)actions.append(el("p","No computer-use actions yet.","empty"));
  document.getElementById("limits").replaceChildren(...state.limitations.map(value=>el("li",value)));
}
async function poll(){
  if(!controlsReady){setupSettings();controlsReady=true}
  try{
    const response=await fetch("state",{cache:"no-store"});if(!response.ok)throw Error("HTTP "+response.status);
    const state=await response.json();
    if(state.revision!==revision||state.sessionId!==session||state.imageSettings?.version!==settingsVersion){render(state);revision=state.revision;session=state.sessionId;settingsVersion=state.imageSettings?.version}
    document.getElementById("connection").textContent="Connected · "+new Date().toLocaleTimeString();
  }catch(error){document.getElementById("connection").textContent="Disconnected · retrying ("+error.message+")"}
  setTimeout(poll,1000);
}
poll();
`;
