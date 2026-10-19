// Synthetic local pages for live browser checks. Run `node scripts/web-fixture.mjs`; it prints the base URL.
// GET /journal returns every page event the fixture recorded, so checks do not rely on the agent's own report.
import { createServer } from "node:http";

const journal = [];
const page = (title, body) => `<!doctype html><meta charset="utf-8"><title>${title}</title>
<script>
const log = (type, detail = {}) => fetch("/journal", { method: "POST", body: JSON.stringify({ page: location.pathname, type, ...detail }) });
addEventListener("load", () => log("load", { nonce: sessionStorage.nonce ?? null }));
</script>${body}`;

const pages = {
  "/": page("Fixture home", `<h1>Fixture home</h1><a href="/tabs">Tabs and dialogs</a>`),
  "/tabs": page("Tabs and dialogs", `<h1>Tabs and dialogs</h1>
<label>Context <input id="context" aria-label="Context"></label>
<button onclick="sessionStorage.nonce = document.querySelector('#context').value; log('saved', { nonce: sessionStorage.nonce }); out('saved ' + sessionStorage.nonce)">Save context</button>
<button onclick="log('popup'); window.open('/popup', '_blank')">Open popup</button>
<button onclick="out('alert closed'); alert('Hello from alert'); log('alert')">Alert</button>
<button onclick="const ok = confirm('Delete the draft?'); log('confirm', { ok }); out('confirm ' + ok)">Confirm</button>
<button onclick="const v = prompt('Your name?', 'guest'); log('prompt', { value: v }); out('prompt ' + v)">Prompt</button>
<button onclick="setTimeout(() => { const ok = confirm('Late question?'); log('late', { ok }); out('late ' + ok) }, 800)">Late confirm</button>
<p role="status" id="out">idle</p>
<iframe title="Inner frame" src="/frame" width="300" height="90"></iframe>
<script>function out(text) { document.querySelector('#out').textContent = text; }</script>`),
  "/frame": page("Inner frame", `<button onclick="const ok = confirm('Frame question?'); log('frame-confirm', { ok }); document.body.dataset.answer = ok; this.textContent = 'frame ' + ok">Frame confirm</button>`),
  "/popup": page("Popup", `<h1>Popup</h1><a href="/popup/next">Next page</a> <button onclick="window.close()">Close me</button>`),
  "/popup/next": page("Popup next", `<h1>Popup next</h1><a href="javascript:history.back()">Back</a>`),
  "/diag": page("Diagnostics", `<h1>Diagnostics</h1>
<button onclick="fetch('/missing.json').then(r => out('fetched ' + r.status))">Fetch 404</button>
<button onclick="fetch('/status/500').then(r => out('fetched ' + r.status))">Fetch 500</button>
<button onclick="fetch('http://127.0.0.1:9/unreachable').catch(e => out('fetch failed'))">Fetch unreachable</button>
<button onclick="setTimeout(() => { throw new Error('fixture exception ' + Date.now()) }); out('threw')">Throw</button>
<button onclick="console.error('fixture console error'); console.log('fixture console log'); out('logged')">Console</button>
<button disabled>Disabled action</button>
<p role="status" id="out">idle</p>
<ul id="items"><li>alpha</li><li>beta</li></ul>
<script>function out(text) { document.querySelector('#out').textContent = text; }</script>`),
  "/wait": page("Wait", `<h1>Wait</h1>
<label>Name <input id="name" aria-label="Name"></label>
<button onclick="const name = document.querySelector('#name').value; out('saving'); setTimeout(() => { out('saved ' + name); log('saved', { name }) }, 800)">Save</button>
<button id="later" disabled>Continue</button>
<button onclick="setTimeout(() => document.querySelector('#later').disabled = false, 600)">Unlock later</button>
<button onclick="setTimeout(() => document.querySelector('#banner')?.remove(), 600)">Dismiss banner</button>
<p id="banner" role="alert">Welcome banner</p>
<button onclick="let n = 0; const t = setInterval(() => { out('tick ' + (++n)); if (n === 20) clearInterval(t) }, 150)">Flicker</button>
<p role="status" id="out">idle</p>
<script>function out(text) { document.querySelector('#out').textContent = text; }</script>`),
  "/long": page("Long list", `<h1>Long list</h1><ol>${Array.from({ length: 1500 }, (_, i) => `<li>Item ${i + 1}</li>`).join("")}</ol><p role="status">end of list</p>`),
  "/files": page("Files", `<h1>Files</h1>
<label>Attachment <input type="file" id="direct" multiple></label>
<input type="file" id="hidden" hidden>
<button onclick="document.querySelector('#hidden').click()">Choose file</button>
<a href="/download/report.txt">Download report</a>
<a href="/download/slow.bin">Download slow file</a>
<p role="status" id="out">idle</p>
<script>
for (const input of document.querySelectorAll('input[type=file]')) input.addEventListener('change', async () => {
  const files = await Promise.all([...input.files].map(async file => ({ name: file.name, size: file.size, text: (await file.text()).slice(0, 40) })));
  log('upload', { input: input.id, files });
  document.querySelector('#out').textContent = input.id + ': ' + files.map(file => file.name + ' ' + file.size).join(', ');
});
</script>`),
};

/** Start the fixture on an ephemeral 127.0.0.1 port. */
export async function startWebFixture() {
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://localhost");
    if (url.pathname === "/journal" && request.method === "POST") {
      let body = "";
      request.on("data", chunk => { body += chunk; });
      request.on("end", () => { journal.push({ at: new Date().toISOString(), ...JSON.parse(body || "{}") }); response.end(); });
      return;
    }
    if (url.pathname === "/journal") return response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(journal, null, 1));
    if (url.pathname === "/status/500") return response.writeHead(500).end("fixture failure");
    if (url.pathname === "/download/report.txt") {
      journal.push({ at: new Date().toISOString(), page: url.pathname, type: "download-served" });
      return response.writeHead(200, { "content-type": "text/plain", "content-disposition": "attachment; filename=report.txt" }).end("fixture report\n");
    }
    if (url.pathname === "/download/slow.bin") {
      // 20 chunks over 10 seconds, so a check can wait, time out or cancel while it is in progress.
      response.writeHead(200, { "content-type": "application/octet-stream", "content-disposition": "attachment; filename=slow.bin", "content-length": String(20 * 1024) });
      let sent = 0;
      const timer = setInterval(() => {
        response.write(Buffer.alloc(1024, sent));
        if (++sent === 20) { clearInterval(timer); response.end(); journal.push({ at: new Date().toISOString(), page: url.pathname, type: "slow-finished" }); }
      }, 500);
      response.on("close", () => { if (sent < 20) { clearInterval(timer); journal.push({ at: new Date().toISOString(), page: url.pathname, type: "slow-aborted", sent }); } });
      return;
    }
    const html = pages[url.pathname];
    if (!html) return response.writeHead(404).end("not found");
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}/`, journal, close: () => new Promise(resolve => server.close(resolve)) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const fixture = await startWebFixture();
  console.log(`FIXTURE ${fixture.url}`);
}
