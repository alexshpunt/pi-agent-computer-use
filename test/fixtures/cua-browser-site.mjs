import { createServer } from "node:http";

/** Disposable local page for native CUA navigation and input checks. */
export async function createCuaBrowserSite() {
  const html = `<!doctype html><meta charset="utf-8"><title>Pi CUA adapter fixture</title>
<style>body{font:24px sans-serif;padding:30px}button,input{font:inherit;margin:8px}#space{height:1200px}</style>
<h1>Pi CUA owned browser</h1><p id="count">Selections: 0</p><p id="storage"></p>
<button>One</button><button>Two</button><button>Three</button><button>Four</button>
<p><label>Message <input id="message"></label><button id="submit">Submit</button></p><p id="result"></p>
<p style="font:14px monospace">Native detail: cedar river 396</p><a href="/next">Next local page</a><div id="space"></div><p>Bottom reached</p>
<script>document.querySelector('#storage').textContent='Previous fixture storage: '+(localStorage.getItem('cua-test')||'empty');let n=0;for(const b of document.querySelectorAll('button:not(#submit)'))b.onclick=()=>document.querySelector('#count').textContent='Selections: '+ ++n;
document.querySelector('#submit').onclick=()=>{const v=document.querySelector('#message').value;document.querySelector('#result').textContent='Submitted: '+v;localStorage.setItem('cua-test',v)};</script>`;
  const server = createServer((req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(req.url === "/next" ? "<!doctype html><title>Pi CUA second fixture</title><h1>Next local page reached</h1><a href='/'>Return</a>" : html);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}/`, close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}
