import http from "node:http";

/** Owned local dynamic UI for temporal vision checks; no external data or browser profile is used. */
export async function createTemporalSite() {
  const html = `<!doctype html><meta charset="utf-8"><title>Pi temporal capture fixture</title>
<style>body{font:24px system-ui;background:#edf3ff;color:#142645;margin:30px}#stage{position:relative;width:650px;height:180px;background:white;border:3px solid #345;overflow:hidden}#block{position:absolute;width:70px;height:70px;top:55px;background:#f45}progress{width:650px;height:35px}#toast{background:#ffe48c;padding:15px;width:620px}button{font:inherit;padding:10px}</style>
<h1>Pi temporal capture fixture</h1><p>Disposable local motion, progress and toast. Read-only capture test.</p>
<p id="clock">Frame 0</p><div id="stage"><div id="block"></div></div><progress id="progress" max="100" value="0"></progress>
<p id="toast">Transient toast</p><button id="pause">Pause animation</button>
<script>let paused=false,n=0;const start=performance.now();function tick(){if(paused)return;const t=performance.now()-start;n++;document.getElementById('clock').textContent='Frame '+n+' · elapsed '+Math.floor(t)+' ms';document.getElementById('block').style.left=(Math.floor(t/6)%580)+'px';document.getElementById('block').style.background=Math.floor(t/1000)%2?'#247ee8':'#f45';document.getElementById('progress').value=Math.floor(t/60)%101;document.getElementById('toast').style.visibility=Math.floor(t/1000)%3===0?'visible':'hidden'}setInterval(tick,100);document.getElementById('pause').onclick=()=>{paused=!paused;document.getElementById('pause').textContent=paused?'Resume animation':'Pause animation'};</script>`;
  const server = http.createServer((request, response) => {
    if (request.url === "/") { response.writeHead(200, { "Content-Type": "text/html" }); response.end(html); }
    else { response.writeHead(404); response.end(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}/`, close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}
