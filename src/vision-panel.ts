/** Static viewer. All observed text goes through textContent, never HTML evaluation. */
export const visionPanel = `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Pi vision debug</title>
<link rel="stylesheet" href="style.css">
<main>
<header><div><p class="eyebrow">PI · COMPUTER USE</p><h1>Vision debug</h1></div><span id="connection">Connecting…</span></header>
<p class="notice"><strong>Final delivery is unconfirmed.</strong> These are exact image bytes at Pi's existing application-boundary hook, not confirmed wire payloads or model embeddings.</p>
<p id="session"></p>
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
let revision=-1,session;
function render(state){
  document.getElementById("session").textContent="Session "+state.sessionId+" · revision "+state.revision;
  const frames=document.getElementById("frames");frames.replaceChildren();
  for(const [i,frame] of state.frames.entries()){
    const card=el("article",undefined,"card");
    card.append(el("h3","t"+(i-state.frames.length+1)+" · "+frame.stage));
    if(frame.stage!=="evicted"){const img=el("img");img.src="images/"+frame.hash;img.alt="Application-boundary frame "+frame.id;card.append(img)}
    card.append(el("p",frame.time+" · "+(frame.width??"?")+"×"+(frame.height??"?")+" · "+frame.bytes+" bytes","meta"));
    card.append(el("p","Request "+frame.requestId+" · action "+(frame.actionId??"unmatched"),"meta"));
    card.append(el("p","SHA-256 "+frame.hash,"meta"));
    card.append(el("p","Clean original: "+frame.original+". No separate capture is substituted.","muted"));
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
  try{
    const response=await fetch("state",{cache:"no-store"});if(!response.ok)throw Error("HTTP "+response.status);
    const state=await response.json();
    if(state.revision!==revision||state.sessionId!==session){render(state);revision=state.revision;session=state.sessionId}
    document.getElementById("connection").textContent="Connected · "+new Date().toLocaleTimeString();
  }catch(error){document.getElementById("connection").textContent="Disconnected · retrying ("+error.message+")"}
  setTimeout(poll,1000);
}
poll();
`;
