import http from "node:http";

/** Two disposable hover pages. This server records browser witnesses; it never sends UI input. */
export async function createPointerHoverSite() {
  const reports = [null, null], events = [[], []], dropped = [0, 0];
  const html = index => `<!doctype html><meta charset="utf-8"><title>Pi native hover ${index ? "sentinel" : "target"}</title>
<style>
body{font:18px system-ui;margin:20px;background:${index ? "#e8ddff" : "#ddeeff"}}
h1{font-size:22px;margin:0 0 8px}button{font:inherit;padding:12px;width:260px}
#menu{width:260px;margin:12px 0}#submenu{display:none;position:fixed;top:20px;right:20px;width:230px;padding:12px;background:#235;color:white}
#menu:hover #submenu{display:block}#tooltip{display:none;background:#ffdb76;padding:10px;width:232px;margin-top:8px}
#tooltip.visible{display:block}#neutral{margin:12px 0;padding:12px;background:white;width:236px}
</style>
<h1>Native hover ${index ? "sentinel" : "target"}</h1>
<div id="neutral" role="img" aria-label="Neutral pointer area ${index}">Neutral pointer area</div>
<div id="menu"><button id="menu-trigger" aria-label="Hover menu ${index}">Hover menu</button><div id="submenu" role="menu">Hover-only menu visible</div></div>
<button id="tooltip-trigger" aria-label="Hover tooltip ${index}" aria-describedby="tooltip">Hover tooltip</button>
<div id="tooltip" role="tooltip">Native hover tooltip visible</div>
<p>Disposable local page. No documents, accounts or external requests.</p>
<script>
const index=${index};let timer,serial=0;const forbidden={mousedown:0,mouseup:0,click:0,dblclick:0,contextmenu:0,keydown:0,keyup:0,input:0,wheel:0};
const tip=document.getElementById('tooltip'),trigger=document.getElementById('tooltip-trigger');
function send(path,value){fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)}).catch(()=>{});}
for(const type of ['pointermove','pointerenter','pointerleave',...Object.keys(forbidden)])document.addEventListener(type,event=>{
if(type in forbidden)forbidden[type]++;send('/event/'+index,{type,target:event.target.id||event.target.tagName,trusted:event.isTrusted,buttons:event.buttons??null,key:event.key??null,x:event.clientX??null,y:event.clientY??null,time:performance.timeOrigin+performance.now()});
},{capture:true});
trigger.addEventListener('pointerenter',()=>{clearTimeout(timer);timer=setTimeout(()=>{tip.classList.add('visible');report();},500);});
trigger.addEventListener('pointerleave',()=>{clearTimeout(timer);tip.classList.remove('visible');report();});
function report(){send('/report/'+index,{serial:++serial,time:Date.now(),menu:getComputedStyle(document.getElementById('submenu')).display!=='none',tooltip:tip.classList.contains('visible'),forbidden:{...forbidden},has_focus:document.hasFocus(),focus:document.activeElement.id||document.activeElement.tagName});}
report();setInterval(report,100);
</script>`;
  const server = http.createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    const path = new URL(request.url, "http://localhost").pathname;
    if (request.method === "GET" && /^\/[01]$/.test(path)) {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); response.end(html(Number(path.slice(1)))); return;
    }
    const match = /^\/(report|event)\/([01])$/.exec(path);
    if (request.method !== "POST" || !match) { response.writeHead(404).end(); return; }
    let body = "";
    for await (const chunk of request) { body += chunk; if (body.length > 4096) { response.writeHead(413).end(); return; } }
    try {
      const value = JSON.parse(body), index = Number(match[2]);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Invalid witness");
      const row = { ...value, received_ms: Date.now() };
      if (match[1] === "report") reports[index] = row;
      else if (events[index].length < 2048) events[index].push(row);
      else dropped[index]++;
      response.writeHead(204).end();
    } catch { response.writeHead(400).end(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}`,
    state: () => structuredClone({ reports, events, dropped }),
    close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}
