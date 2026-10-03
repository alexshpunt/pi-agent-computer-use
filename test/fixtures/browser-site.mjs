import http from "node:http";

const style = '<style>body{font:20px system-ui;max-width:850px;margin:35px;background:#f5f8ff;color:#172540}a,button,input{font:inherit}button,input{padding:10px}section{margin:25px 0}.space{height:1700px}</style>';

/** Owned local fixture: synthetic pages only, loopback and an ephemeral port. Caller closes the server. */
export async function startBrowserFixture() {
  const server = http.createServer((request, response) => {
    const route = new URL(request.url, "http://127.0.0.1").pathname;
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    if (route === "/") response.end('<!doctype html><title>Pi browser start</title>' + style +
      '<h1>Agent-owned visible browser</h1><p>This is a disposable local test, not your personal browser.</p><a href="/form">Open message form</a>');
    else if (route === "/form") response.end('<!doctype html><title>Pi browser form</title>' + style +
      '<h1>Message form</h1><form><label>Message <input name="message" aria-label="Message"></label> <button>Submit message</button></form>' +
      '<section id="result" role="status">No message yet</section><section id="storage"></section><a href="/">Back to start</a><div class="space"></div><h2>Lower page section</h2><a href="/second" target="_blank">Open second tab</a>' +
      '<script>const storage=()=>{document.querySelector("#storage").textContent="Storage marker: "+(localStorage.getItem("pi-browser-marker")||"absent")+"; Cookie marker: "+(document.cookie.includes("piBrowserMarker=test")?"present":"absent");};storage();document.querySelector("form").onsubmit=event=>{event.preventDefault();const value=document.querySelector("input").value;document.querySelector("#result").textContent="Confirmed: "+value;localStorage.setItem("pi-browser-marker",value);document.cookie="piBrowserMarker=test; SameSite=Lax";storage();};</script>');
    else if (route === "/second") response.end('<!doctype html><title>Pi browser second tab</title>' + style +
      '<h1>Second owned tab</h1><p>Same agent profile, separate page reference.</p>');
    else { response.statusCode = 404; response.end("<title>Not found</title>Not found"); }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const url = "http://127.0.0.1:" + server.address().port;
  return { url, server, close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}
