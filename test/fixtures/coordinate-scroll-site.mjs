import http from "node:http";

/** Disposable custom wheel surfaces and independent browser witnesses; no browser control API. */
export async function createCoordinateScrollSite() {
  const reports = [null, null], events = [[], []], dropped = [0, 0];
  const html = index => `<!doctype html><meta charset="utf-8"><title>Pi coordinate scroll ${index ? "sentinel" : "target"}</title>
<style>
*{box-sizing:border-box}body{font:18px system-ui;margin:16px;background:${index ? "#eee4ff" : "#e1efff"};overflow:hidden}
h1{font-size:22px;margin:0 0 8px}p{margin:8px 0}#offsets{font:bold 22px monospace;margin:12px 0}
canvas{display:block;width:100%;height:420px;max-height:65vh;border:4px solid #234;touch-action:none;background:white}
</style>
<h1>Coordinate scroll ${index ? "sentinel" : "target"}</h1>
<p>Custom wheel surface — no native scrollbars or accessibility scroll target.</p>
<div id="offsets">X 256 · Y 256</div>
<canvas id="wheel-surface" role="img" aria-label="Custom wheel grid ${index}"></canvas>
<p id="counts">Wheel events: 0 · forbidden input: 0</p>
<p>Disposable localhost page. Grid distance is this app's choice, not native pixel-scroll evidence.</p>
<script>
const index=${index},surface=document.getElementById('wheel-surface'),context=surface.getContext('2d');
let x=256,y=256,serial=0,wheels=0,trustedWheels=0;
const forbidden={mousedown:0,mouseup:0,click:0,dblclick:0,contextmenu:0,keydown:0,keyup:0,input:0,beforeinput:0};
function send(path,value){fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)}).catch(()=>{});}
function paint(){
const width=Math.round(surface.clientWidth),height=Math.round(surface.clientHeight);
surface.width=width;surface.height=height;context.fillStyle='#fff';context.fillRect(0,0,width,height);
for(let gx=Math.floor(x/100)*100;gx<x+width;gx+=100)for(let gy=Math.floor(y/100)*100;gy<y+height;gy+=100){
context.fillStyle=((gx/100+gy/100)%2)?'#c7def7':'#e8f1fb';context.fillRect(gx-x,gy-y,98,98);
context.fillStyle='#234';context.font='18px monospace';context.fillText(gx+','+gy,gx-x+8,gy-y+28);
}
context.strokeStyle='#ba2540';context.lineWidth=3;context.beginPath();context.moveTo(width/2-18,height/2);context.lineTo(width/2+18,height/2);context.moveTo(width/2,height/2-18);context.lineTo(width/2,height/2+18);context.stroke();
document.getElementById('offsets').textContent='X '+x+' · Y '+y;
document.getElementById('counts').textContent='Wheel events: '+wheels+' · forbidden input: '+Object.values(forbidden).reduce((sum,value)=>sum+value,0);
}
function report(){send('/report/'+index,{serial:++serial,time:Date.now(),offset:{x,y},wheels,trusted_wheels:trustedWheels,forbidden:{...forbidden},has_focus:document.hasFocus(),focus:document.activeElement.id||document.activeElement.tagName,viewport:{width:innerWidth,height:innerHeight,device_pixel_ratio:devicePixelRatio},surface:{width:surface.clientWidth,height:surface.clientHeight}});}
for(const type of ['pointermove','pointerenter','pointerleave','wheel',...Object.keys(forbidden)])document.addEventListener(type,event=>{
if(type in forbidden){forbidden[type]++;paint();}
if(type==='wheel'){wheels++;if(event.isTrusted)trustedWheels++;paint();}
send('/event/'+index,{type,target:event.target.id||event.target.tagName,trusted:event.isTrusted,buttons:event.buttons??null,key:event.key??null,x:event.clientX??null,y:event.clientY??null,delta_x:event.deltaX??null,delta_y:event.deltaY??null,delta_mode:event.deltaMode??null,ctrl:event.ctrlKey??false,alt:event.altKey??false,shift:event.shiftKey??false,meta:event.metaKey??false,time:performance.timeOrigin+performance.now()});
},{capture:true});
surface.addEventListener('wheel',event=>{
event.preventDefault();if(event.isTrusted){
// The app chooses its visual distance. Browser wheel deltas are not native detents or guaranteed pixels.
const factor=event.deltaMode===1?24:event.deltaMode===2?surface.clientHeight:1;
x=Math.round(Math.max(0,Math.min(2048,x+event.deltaX*factor)));
y=Math.round(Math.max(0,Math.min(2048,y+event.deltaY*factor)));
}paint();report();
},{passive:false});
addEventListener('resize',()=>{paint();report();});paint();report();setInterval(report,100);
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
    for await (const chunk of request) { body += chunk; if (Buffer.byteLength(body) > 4096) { response.writeHead(413).end(); return; } }
    try {
      const value = JSON.parse(body), index = Number(match[2]);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Invalid witness");
      const row = { ...value, received_ms: Date.now() };
      if (match[1] === "report") {
        if (!Number.isSafeInteger(row.serial) || row.serial < 1) throw Error("Invalid report serial");
        if (!reports[index] || row.serial > reports[index].serial) reports[index] = row;
      } else if (events[index].length < 2048) events[index].push(row);
      else dropped[index]++;
      response.writeHead(204).end();
    } catch { response.writeHead(400).end(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}`,
    state: () => structuredClone({ reports, events, dropped }),
    close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}
