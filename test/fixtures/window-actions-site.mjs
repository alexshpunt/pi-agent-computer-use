import http from "node:http";

/** Local disposable controls and an independent event oracle for two-window input checks. */
export async function createWindowActionsSite() {
  const events = [[], []];
  const page = index => `<!doctype html><meta charset="utf-8"><title>Pi window actions fixture ${index + 1}</title>
<style>body{margin:20px;font:20px system-ui;background:${index ? "#daf3dd" : "#dde6ff"}}h1{font-size:25px}button{font:inherit;padding:14px 36px}#drag{margin:20px auto 0;width:440px;height:90px;background:#24344e;color:white;display:grid;place-items:center;touch-action:none;user-select:none}#scroll{margin-top:20px;height:170px;width:440px;overflow:auto;background:white;border:3px solid #24344e}#scroll p{padding:20px;margin:0}output{display:block;margin-top:12px}</style>
<h1>WINDOW FIXTURE ${index + 1}</h1><button id="click">Click fixture ${index + 1}</button><output id="result">Clicks 0; drags 0; scroll 0</output>
<div id="drag" role="img" aria-label="Drag surface ${index + 1}">Drag left to right</div>
<div id="scroll" tabindex="0" aria-label="Scrollable fixture ${index + 1}">${Array.from({length:20},(_,n)=>`<p>Scroll row ${n + 1}</p>`).join("")}</div>
<script>
let clicks=0,drags=0,scroll=0,start=null;
const result=document.getElementById('result'),drag=document.getElementById('drag'),area=document.getElementById('scroll');
function report(kind,data){result.textContent='Clicks '+clicks+'; drags '+drags+'; scroll '+scroll;fetch('/event/${index}',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({kind,...data})});}
document.getElementById('click').onclick=event=>{clicks++;report('click',{x:event.clientX,y:event.clientY});};
drag.onpointerdown=event=>{start={x:event.clientX,y:event.clientY};drag.setPointerCapture(event.pointerId);};
drag.onpointerup=event=>{if(!start)return;drags++;report('drag',{from:start,to:{x:event.clientX,y:event.clientY}});start=null;};
area.onscroll=()=>{scroll=Math.round(area.scrollTop);report('scroll',{top:scroll});};
report('ready',{});
</script>`;
  const server = http.createServer(async (request, response) => {
    const path = new URL(request.url, "http://localhost").pathname;
    if (request.method === "GET" && path === "/state") {
      response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify(events)); return;
    }
    const event = /^\/event\/([01])$/.exec(path);
    if (request.method === "POST" && event) {
      let body = "";
      for await (const chunk of request) {
        body += chunk;
        if (body.length > 4096) { response.writeHead(413).end(); return; }
      }
      try {
        const value = JSON.parse(body);
        if (!["ready", "click", "drag", "scroll"].includes(value.kind)) throw Error("Unknown fixture event");
        events[Number(event[1])].push({ ...value, received_ms: Date.now() });
        response.writeHead(204).end();
      } catch { response.writeHead(400).end(); }
      return;
    }
    if (request.method === "GET" && /^\/[01]$/.test(path)) {
      response.writeHead(200, { "Content-Type": "text/html" }); response.end(page(Number(path.slice(1)))); return;
    }
    response.writeHead(404).end();
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    state: () => structuredClone(events),
    close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}
