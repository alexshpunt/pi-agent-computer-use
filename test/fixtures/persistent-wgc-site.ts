import http from "node:http";

/** Own a changing compositor witness. JS draw acknowledgements are not compositor timestamps. */
export async function createPersistentWgcSite() {
  let revision = 0;
  const events: { type: "pointerdown" | "click"; target: string; x: number; y: number; count: number }[] = [];
  const acknowledgementFrames = 3;
  let published = performance.now();
  const acknowledged = new Map<number, number>();
  const drawn = new Map<number, number>();
  let drawWait: { revision: number; resolve: (time: number) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> } | undefined;
  let closed = false;
  const color = (n: number) => [40 + (n % 4) * 60, 40 + (Math.floor(n / 4) % 4) * 60, 40 + Math.floor(n / 16) * 80];
  const html = `<!doctype html><meta charset="utf-8"><title>Pi persistent WGC fixture</title>
<style>body{font:20px Arial;background:#f3f6ff;color:#15213a;margin:24px}canvas{display:block;border:3px solid #15213a;width:min(620px,85vw);height:180px}</style>
<h1>Pi persistent WGC fixture</h1><p>Owned changing pixels and disposable test controls. No personal content.</p>
<canvas width="620" height="180" aria-label="Capture marker"></canvas>
<button id="save" style="font:24px Arial;padding:16px;margin-top:18px">Save WGC fixture</button><output id="count" aria-label="Click count">Clicks: 0</output>
<script>const c=document.querySelector('canvas'),ctx=c.getContext('2d');let state={revision:0,color:${JSON.stringify(color(0))}},seen=-1,tick=0,revisionFrames=0;
// Allow complete browser frame cycles before acknowledging, without claiming a compositor timestamp.
function paint(){if(seen!==state.revision){seen=state.revision;revisionFrames=0}ctx.fillStyle='rgb('+state.color.join(',')+')';ctx.fillRect(0,0,620,180);ctx.fillStyle='#fff';ctx.font='28px Arial';ctx.fillText('Revision '+state.revision+' / tick '+(++tick),20,50);if(++revisionFrames===1){fetch('/draw',{method:'POST',body:JSON.stringify({revision:seen})})}if(revisionFrames===${acknowledgementFrames}){fetch('/paint',{method:'POST',body:JSON.stringify({revision:seen})})}requestAnimationFrame(paint)}paint();
let clicks=0;const save=document.getElementById('save');for(const type of ['pointerdown','click'])save.addEventListener(type,e=>{if(type==='click')document.getElementById('count').textContent='Clicks: '+(++clicks);fetch('/event',{method:'POST',body:JSON.stringify({type,target:'save',x:e.clientX,y:e.clientY,count:clicks})})});
async function poll(){try{state=await(await fetch('/state',{cache:'no-store'})).json()}finally{setTimeout(poll,16)}}poll();</script>`;
  const server = http.createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/") {
      response.writeHead(200, { "Content-Type": "text/html" }); response.end(html); return;
    }
    if (request.method === "GET" && request.url === "/state") {
      response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      response.end(JSON.stringify({ revision, color: color(revision) })); return;
    }
    if (request.method === "GET" && request.url === "/events") {
      response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      response.end(JSON.stringify(events)); return;
    }
    if (request.method === "POST" && request.url === "/event") {
      let body = "";
      for await (const chunk of request) {
        body += chunk;
        if (body.length > 1024) { response.writeHead(413); response.end(); return; }
      }
      try {
        const value = JSON.parse(body);
        if (!["pointerdown","click"].includes(value.type) || value.target !== "save" ||
          ![value.x,value.y].every(v => Number.isFinite(v) && v >= 0 && v <= 16384) ||
          !Number.isSafeInteger(value.count) || value.count < 0 || value.count > 8 || events.length >= 16) throw Error("Invalid event");
        events.push({ type: value.type, target: value.target, x: value.x, y: value.y, count: value.count });
        response.writeHead(204);
      } catch { response.writeHead(400); }
      response.end(); return;
    }
    if (request.method === "POST" && (request.url === "/paint" || request.url === "/draw")) {
      let body = "";
      for await (const chunk of request) {
        body += chunk;
        if (body.length > 1024) { response.writeHead(413); response.end(); return; }
      }
      try {
        const value = JSON.parse(body);
        if (!Number.isSafeInteger(value.revision) || value.revision < 0 || value.revision > revision) throw Error("Invalid revision");
        const receipts = request.url === "/draw" ? drawn : acknowledged;
        if (!receipts.has(value.revision)) receipts.set(value.revision, performance.now());
        if (request.url === "/draw" && drawWait && drawWait.revision === value.revision) {
          clearTimeout(drawWait.timer); drawWait.resolve(drawn.get(value.revision)!); drawWait = undefined;
        }
        response.writeHead(204);
      } catch { response.writeHead(400); }
      response.end(); return;
    }
    response.writeHead(404); response.end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("Fixture requires a local TCP port");
  return {
    url: `http://127.0.0.1:${address.port}/`,
    acknowledgementFrames,
    events: () => structuredClone(events),
    advance() { if (revision >= 40) throw Error("Revision budget exhausted"); published = performance.now(); return ++revision; },
    state: () => ({ revision, color: color(revision), acknowledged: acknowledged.has(revision),
      published_ms: published, drawn_ms: drawn.get(revision), acknowledged_ms: acknowledged.get(revision) }),
    /** Wait for the first JS draw receipt, never claiming compositor presentation. */
    waitForDraw(requested: number, timeoutMs: number): Promise<number> {
      if (closed || requested !== revision || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2000 || drawWait) {
        return Promise.reject(Error("Invalid or closed fixture draw wait"));
      }
      const time = drawn.get(requested);
      if (time !== undefined) return Promise.resolve(time);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { drawWait = undefined; reject(Error("Fixture draw deadline exhausted")); }, timeoutMs);
        drawWait = { revision: requested, resolve, reject, timer };
      });
    },
    close: () => {
      closed = true;
      if (drawWait) { clearTimeout(drawWait.timer); drawWait.reject(Error("Fixture closed")); drawWait = undefined; }
      return new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}
