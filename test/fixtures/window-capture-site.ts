import http from "node:http";

/** Own a disposable changing-pixel witness. Paint acknowledgements are JS events, not compositor timestamps. */
export async function createWindowCaptureSite() {
  let revision = 0;
  const acknowledged = new Set();
  const events: { type: "click"; count: number }[] = [];
  const color = (n: number) => [43 + (n % 10) * 17, 181 - (n % 10) * 11, 71 + (n % 10) * 9];
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Pi window capture fixture</title>
<style>body{font:20px Arial;background:#f3f6ff;color:#15213a;margin:24px}canvas{display:block;border:3px solid #15213a;width:min(620px,85vw);height:180px}button{font:20px Arial;padding:14px;margin:12px 0}</style></head>
<body><h1>Pi window capture fixture</h1><p>Owned changing pixels. No personal content.</p>
<canvas id="marker" width="620" height="180" role="img" aria-label="Capture marker"></canvas>
<button id="save">Save</button><output id="count" aria-label="Click count">Clicks: 0</output>
<script>const c=document.getElementById('marker'),ctx=c.getContext('2d');let seen=-1,count=0;
async function tick(){try{const s=await(await fetch('/state',{cache:'no-store'})).json();if(s.revision!==seen){seen=s.revision;ctx.fillStyle='rgb('+s.color.join(',')+')';ctx.fillRect(0,0,620,180);ctx.fillStyle='#fff';ctx.font='28px Arial';ctx.fillText('Frame '+seen,20,50);fetch('/paint',{method:'POST',body:JSON.stringify({revision:seen})});}}finally{setTimeout(tick,40)}}tick();
document.getElementById('save').onclick=()=>{document.getElementById('count').textContent='Clicks: '+(++count);fetch('/event',{method:'POST',body:JSON.stringify({type:'click',count})})};
</script></body></html>`;
  const server = http.createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/") {
      response.writeHead(200, { "Content-Type": "text/html" }); response.end(html); return;
    }
    if (request.method === "GET" && request.url === "/state") {
      response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      response.end(JSON.stringify({ revision, color: color(revision) })); return;
    }
    if (request.method === "POST" && ["/paint", "/event"].includes(request.url ?? "")) {
      let body = "";
      for await (const chunk of request) {
        body += chunk;
        if (body.length > 1024) { response.writeHead(413); response.end(); return; }
      }
      try {
        const value = JSON.parse(body);
        if (request.url === "/paint") {
          if (!Number.isSafeInteger(value.revision) || value.revision < 0 || value.revision > revision) throw Error("Invalid revision");
          acknowledged.add(value.revision);
        } else {
          if (value.type !== "click" || !Number.isSafeInteger(value.count) || events.length >= 16) throw Error("Invalid event");
          events.push({ type: "click", count: value.count });
        }
        response.writeHead(204);
      } catch { response.writeHead(400); }
      response.end(); return;
    }
    response.writeHead(404); response.end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("Fixture must listen on a local TCP port");
  return {
    url: `http://127.0.0.1:${address.port}/`,
    advance() { if (revision >= 48) throw Error("Witness revision budget exhausted"); return ++revision; },
    state: () => ({ revision, color: color(revision), acknowledged: acknowledged.has(revision) }),
    events: () => structuredClone(events),
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}
