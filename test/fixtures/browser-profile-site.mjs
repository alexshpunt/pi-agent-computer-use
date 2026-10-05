import { createServer } from "node:http";

/** Owned synthetic page and server-side effect counters; no real user data or external forms. */
export async function createBrowserProfileSite() {
  const state = { clicks: 0, inputs: 0, hovers: 0, scrolls: 0, visits: 0 };
  const html = `<!doctype html><meta charset="utf-8"><title>Browser timing fixture</title>
<style>body{margin:0;font:24px sans-serif;background:#c9f5ff;min-height:2000px}header{padding:24px;background:white}button,input,a{font:inherit;margin:8px}#pad{padding:50px;height:1400px}</style>
<header><h1>Browser timing fixture</h1><button>Count</button><label>Message <input></label><a href="/next">Next page</a></header>
<div id="pad">Pixel test area — clicks are counted anywhere in this page.</div>
<script>
const record=kind=>fetch('/event/'+kind,{method:'POST'});
document.addEventListener('click',()=>record('clicks'));
document.querySelector('input').addEventListener('input',()=>record('inputs'));
document.querySelector('a').addEventListener('mouseenter',()=>record('hovers'));
window.addEventListener('scroll',()=>record('scrolls'));
</script>`;
  const server = createServer((req, res) => {
    const kind = req.url?.slice('/event/'.length);
    if (req.method === 'POST' && req.url?.startsWith('/event/') && Object.hasOwn(state, kind)) {
      state[kind]++; res.writeHead(204); res.end(); return;
    }
    if (req.url === '/next') state.visits++;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(html);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}/`, state,
    close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}
