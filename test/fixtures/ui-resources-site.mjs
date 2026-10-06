import http from "node:http";

/** Disposable UIA fixture. Event readback is verification only, never an input path. */
export async function createUiResourcesSite() {
  const events = [];
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Pi UI resources fixture</title>
<style>body{font:18px Arial;margin:20px;color:#15213a;background:#f3f6ff}button,input,textarea,select{font:18px Arial;margin:10px;padding:8px}section{border:2px solid #789;padding:18px;margin:16px}#dense button{font-size:14px;margin:4px;padding:5px}canvas{border:2px solid #537;width:360px;height:100px}textarea{width:350px;height:100px}</style></head>
<body><h1>Pi UI resources fixture</h1><output aria-label="Click count" id="count">Clicks: 0</output>
<section role="group" aria-label="Left panel" id="left"><button id="first">Save</button><button disabled>Unavailable</button>
<input aria-label="Message" id="message" value="empty"><input type="checkbox" aria-label="Toggle"><select aria-label="Choice"><option>One</option><option>Two</option></select></section>
<section role="group" aria-label="Right panel"><button id="second">Save</button><button id="replace">Replace first control</button></section>
<section role="group" aria-label="Dense controls" id="dense"></section>
<textarea aria-label="Scrollable notes" id="notes" readonly></textarea><canvas id="canvas" width="360" height="100"></canvas>
<script>let count=0;const emit=(type,value)=>fetch('/event',{method:'POST',body:JSON.stringify({type,value,time:performance.now()})});
const bind=button=>button.onclick=()=>{document.getElementById('count').textContent='Clicks: '+(++count);emit('click',button.id)};
bind(document.getElementById('first'));bind(document.getElementById('second'));
document.getElementById('replace').onclick=()=>{const old=document.getElementById('first'),next=old.cloneNode(true);old.replaceWith(next);bind(next);document.getElementById('left').style.paddingLeft='60px';emit('replace',true)};
document.getElementById('message').oninput=e=>emit('value',e.target.value);
document.querySelector('[aria-label="Toggle"]').onchange=e=>emit('toggle',e.target.checked);
document.querySelector('[aria-label="Choice"]').onchange=e=>emit('choice',e.target.value);
for(let i=1;i<=24;i++){const b=document.createElement('button');b.textContent='Item '+i;b.onclick=()=>emit('dense',i);document.getElementById('dense').append(b)}
const notes=document.getElementById('notes');notes.value=Array.from({length:80},(_,i)=>'Note '+(i+1)).join('\\n');notes.onscroll=()=>emit('scroll',notes.scrollTop);
const ctx=document.getElementById('canvas').getContext('2d');ctx.fillStyle='#cde';ctx.fillRect(0,0,360,100);ctx.fillStyle='#234';ctx.font='18px Arial';ctx.fillText('Pixels without child controls',20,50);
</script></body></html>`;
  const server = http.createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/") { response.writeHead(200, { "Content-Type": "text/html" }); response.end(html); }
    else if (request.method === "POST" && request.url === "/event") {
      let body = ""; for await (const chunk of request) { body += chunk; if (body.length > 4096) { response.writeHead(413); response.end(); return; } }
      try { events.push(JSON.parse(body)); response.writeHead(204); } catch { response.writeHead(400); } response.end();
    } else if (request.method === "GET" && request.url === "/events") { response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify(events)); }
    else { response.writeHead(404); response.end(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}/`, events: () => structuredClone(events),
    close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}
