import { createServer } from "node:http";

/** Local event witness for complete native input; it never injects input into the page. */
export async function createCompleteInputSite() {
  const events = [];
  const html = `<!doctype html><meta charset="utf-8"><title>Pi complete input fixture</title>
<style>body{font:20px sans-serif;margin:16px}input,button{font:inherit;margin:6px}canvas{touch-action:none;background:#fff;border:2px solid #246}#scroll{width:200px;height:90px;overflow:auto;border:2px solid #864}#row{display:flex;gap:20px}</style>
<h1>Complete CUA input</h1><label>Message <input id="message" autocomplete="off"></label><button id="pad">Pointer pad</button>
<div id="row"><div><canvas id="board" tabindex="0" role="img" aria-label="Drawing board" width="550" height="200"></canvas></div><div id="scroll" role="region" aria-label="Scroll area" tabindex="0"><p>Scroll start</p><div style="height:700px"></div><p>Scroll end</p></div></div>
<p id="status">Strokes: 0</p><p id="keys">Keys: 0</p>
<script>
const board=document.querySelector('#board'),ctx=board.getContext('2d'),message=document.querySelector('#message');let stroke=null,n=0,k=0;
function record(e,extra={}){const r={type:e.type,time:performance.timeOrigin+performance.now(),target:e.target.id,key:e.key,code:e.code,button:e.button,buttons:e.buttons,pointerType:e.pointerType,pointerId:e.pointerId,x:e.offsetX,y:e.offsetY,ctrl:e.ctrlKey,shift:e.shiftKey,alt:e.altKey,meta:e.metaKey,value:message.value,...extra};fetch('/event',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(r)});}
for(const type of ['keydown','keyup','input','mousedown','mouseup','click','dblclick','contextmenu','wheel'])document.addEventListener(type,e=>{if(type==='contextmenu')e.preventDefault();if(type==='keydown')document.querySelector('#keys').textContent='Keys: '+ ++k;record(e);},{capture:true});
board.addEventListener('mousedown',()=>board.focus());
document.querySelector('#pad').addEventListener('click',e=>{if(e.shiftKey)e.target.textContent='Shift selected';});
board.addEventListener('pointerdown',e=>{stroke={x:e.offsetX,y:e.offsetY};board.setPointerCapture(e.pointerId);ctx.beginPath();ctx.moveTo(stroke.x,stroke.y);record(e);});
board.addEventListener('pointermove',e=>{if(stroke&&(e.buttons&1)){ctx.lineWidth=4;ctx.strokeStyle=e.shiftKey?'#2a8':'#135';ctx.lineTo(e.offsetX,e.offsetY);ctx.stroke();record(e);}});
board.addEventListener('pointerup',e=>{if(stroke){document.querySelector('#status').textContent='Strokes: '+ ++n;record(e,{stroke:n});stroke=null;}});
document.querySelector('#scroll').addEventListener('scroll',e=>record(e,{scrollTop:e.target.scrollTop}));
</script>`;
  const server = createServer((req, res) => {
    if (req.url === "/event" && req.method === "POST") {
      let body = ""; req.on("data", chunk => { body += chunk; });
      req.on("end", () => { try { events.push(JSON.parse(body)); res.writeHead(204).end(); } catch { res.writeHead(400).end(); } }); return;
    }
    if (req.url === "/events") { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(events)); return; }
    res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end(html);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}/`, events: () => [...events].sort((a,b) => a.time-b.time),
    close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}
