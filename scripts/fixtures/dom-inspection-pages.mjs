import assert from "node:assert/strict";

const paths = new Map([["/", "root"], ["/frame", "frame"], ["/nested", "nested"], ["/cross", "cross"]]);
const eventTypes = ["keydown", "keyup", "beforeinput", "input", "mousedown", "mouseup", "pointerdown", "pointerup", "wheel", "click"];
const keys = (value, expected) => assert.deepEqual(Object.keys(value).sort(), [...expected].sort());
function loopbackOrigin(value) {
  const url = new URL(value);
  assert.equal(url.protocol, "http:");
  assert.equal(url.hostname, "127.0.0.1");
  assert.ok(url.port && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash);
  return url.origin;
}

/** Validate a bounded readonly browser witness. CSS geometry is never native input authority. */
export function validateDomInspectionReport(report, nonce) {
  assert.ok(report && typeof report === "object" && !Array.isArray(report));
  keys(report, ["nonce", "page", "pageNonce", "serial", "stage", "events", "eventOverflow", "detached", "geometrySpace", "viewport", "nodes"]);
  assert.equal(report.nonce, nonce);
  assert.ok([...paths.values()].includes(report.page));
  assert.match(report.pageNonce, /^[a-f0-9-]{36}$/);
  assert.ok(Number.isInteger(report.serial) && report.serial >= 1 && report.serial <= 512);
  assert.ok(report.stage === 0 || report.stage === 1);
  assert.equal(typeof report.detached, "boolean");
  assert.equal(report.detached, report.stage === 1);
  assert.equal(report.geometrySpace, "css_viewport_pixels");
  assert.ok(report.viewport && typeof report.viewport === "object" && !Array.isArray(report.viewport));
  keys(report.viewport, ["width", "height", "device_pixel_ratio", "scroll_x", "scroll_y"]);
  assert.ok(Object.values(report.viewport).every(Number.isFinite) && report.viewport.width > 0 && report.viewport.height > 0 &&
    report.viewport.device_pixel_ratio > 0 && report.viewport.device_pixel_ratio <= 16);
  assert.equal(typeof report.eventOverflow, "boolean");
  assert.ok(Array.isArray(report.events) && report.events.length <= 32);
  for (const event of report.events) {
    keys(event, ["type", "trusted", "target"]);
    assert.ok(eventTypes.includes(event.type) && typeof event.trusted === "boolean");
    assert.ok(typeof event.target === "string" && event.target.length <= 80);
  }
  assert.ok(Array.isArray(report.nodes) && report.nodes.length <= 12);
  assert.equal(new Set(report.nodes.map(node => node.id)).size, report.nodes.length);
  for (const node of report.nodes) {
    keys(node, ["id", "connected", "hidden", "disabled", "checked", "selected", "value", "attributes", "bounds"]);
    assert.ok(typeof node.id === "string" && node.id.length <= 80);
    for (const field of ["connected", "hidden", "disabled", "checked", "selected"]) assert.equal(typeof node[field], "boolean");
    assert.ok(typeof node.value === "string" && node.value.length <= 100);
    keys(node.attributes, ["data-testid", "aria-label", "data-generation", "title"]);
    assert.ok(Object.values(node.attributes).every(value => value === null || typeof value === "string" && value.length <= 100));
    keys(node.bounds, ["x", "y", "width", "height"]);
    assert.ok(Object.values(node.bounds).every(Number.isFinite) && node.bounds.width >= 0 && node.bounds.height >= 0);
  }
  return structuredClone(report);
}

function pageHtml(page, nonce, crossOrigin, transitionAfterMs) {
  const frames = page === "root"
    ? `<iframe title="Same-origin frame" src="/frame"></iframe><iframe title="Cross-origin frame" src="${crossOrigin}/cross"></iframe>`
    : page === "frame" ? '<iframe title="Nested same-origin frame" src="/nested"></iframe>' : "";
  return `<!doctype html><meta charset="utf-8"><title>Pi DOM inspection ${nonce} ${page}</title>
<style>body{font:18px sans-serif;margin:18px}button,input,select{font:inherit;margin:6px;padding:6px}iframe{display:block;width:540px;height:280px;border:2px solid #678;margin:12px 0}#shadow{padding:12px;background:#eef}#hidden{display:none}</style>
<h1>${page} DOM fixture</h1><p>Run ${nonce}</p>
<section aria-label="Duplicate label scope"><button id="duplicate-a" data-testid="duplicate-a" aria-label="Duplicate choice">First duplicate</button><button id="duplicate-b" data-testid="duplicate-b" aria-label="Duplicate choice">Second duplicate</button></section>
<label for="value">Accessible field label</label><input id="value" data-testid="value" value="fixture value" title="Field attribute">
<button id="disabled" data-testid="disabled" disabled>Disabled choice</button><button id="hidden" data-testid="hidden">Hidden choice</button>
<label><input id="checked" type="checkbox" checked>Checked choice</label><select id="selected" aria-label="Selected choice"><option>First</option><option selected value="second">Second</option></select>
<button id="replaceable" data-testid="replaceable" aria-label="Dynamic choice">Original generation</button><button id="detachable" data-testid="detachable">Detaches after transition</button>
<button id="transition">Run fixture transition once</button><div id="shadow"></div>${frames}
<script>
const nonce=${JSON.stringify(nonce)}, page=${JSON.stringify(page)}, pageNonce=crypto.randomUUID();
const shadow=document.querySelector('#shadow').attachShadow({mode:'open'});
shadow.innerHTML='<button id="shadow-choice" data-testid="shadow-choice" aria-label="Duplicate choice">Shadow choice</button><label for="shadow-value">Shadow label</label><input id="shadow-value" value="shadow value">';
let stage=0,serial=0,events=[],eventOverflow=false,pending=false,ended=false;
const detached=document.querySelector('#detachable');
for(const type of ${JSON.stringify(eventTypes)}) document.addEventListener(type,event=>{
 const target=event.composedPath()[0];if(events.length<32)events.push({type,trusted:event.isTrusted,target:String(target.id||'').slice(0,80)});else eventOverflow=true;
},true);
function transition(){if(ended||stage)return;stage=1;const old=document.querySelector('#replaceable'),replacement=old.cloneNode(true);
 replacement.textContent='Replacement generation';replacement.dataset.generation='1';old.replaceWith(replacement);detached.remove();send();}
document.querySelector('#transition').onclick=transition;
function nodeState(node){const r=node.getBoundingClientRect();return {id:node.id,connected:node.isConnected,hidden:!node.getClientRects().length,
 disabled:!!node.disabled,checked:!!node.checked,selected:node.id==='selected'?node.selectedIndex===1:false,value:String(node.value||'').slice(0,100),
 attributes:Object.fromEntries(['data-testid','aria-label','data-generation','title'].map(key=>[key,node.getAttribute(key)])),bounds:{x:r.x,y:r.y,width:r.width,height:r.height}};}
async function send(){if(ended||pending)return;if(serial>=512){ended=true;return;}pending=true;
 const nodes=[...document.querySelectorAll('#duplicate-a,#duplicate-b,#value,#disabled,#hidden,#checked,#selected,#replaceable'),detached,...shadow.querySelectorAll('button,input')].map(nodeState);
 try{await fetch('/dom-witness',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({nonce,page,pageNonce,serial:++serial,stage,events,eventOverflow,detached:!detached.isConnected,geometrySpace:'css_viewport_pixels',viewport:{width:innerWidth,height:innerHeight,device_pixel_ratio:devicePixelRatio,scroll_x:scrollX,scroll_y:scrollY},nodes})});}catch{}finally{pending=false;}}
send();const interval=setInterval(send,500);setTimeout(()=>{ended=true;clearInterval(interval);},300000);
${transitionAfterMs ? `setTimeout(transition,${transitionAfterMs});` : ""}
</script>`;
}

/**
 * Create localhost HTTP handlers without opening browsers or starting servers.
 * Both caller-owned servers use handle; only /cross is served by crossOrigin.
 * reports() returns bounded original witnesses. A nonzero rejected count or eventOverflow is not clean acceptance.
 * Timer transitions are opt-in (1..240000ms); zero leaves explicit fixture-button control only.
 */
export function createDomInspectionPages({ nonce, origin, crossOrigin, transitionAfterMs = 0, maxReports = 2048 }) {
  assert.match(nonce, /^[a-f0-9-]{36}$/);
  origin = loopbackOrigin(origin); crossOrigin = loopbackOrigin(crossOrigin);
  assert.notEqual(origin, crossOrigin, "Use distinct loopback ports for the cross-origin frame.");
  assert.ok(Number.isInteger(transitionAfterMs) && transitionAfterMs >= 0 && transitionAfterMs <= 240000);
  assert.ok(Number.isInteger(maxReports) && maxReports >= 1 && maxReports <= 2048);
  const reports = [], latest = new Map();
  let rejected = 0;
  const html = new Map([...paths].map(([path, page]) => [path, pageHtml(page, nonce, crossOrigin, transitionAfterMs)]));
  return {
    reports: () => structuredClone(reports),
    status: () => ({ count: reports.length, rejected, capacity: maxReports }),
    async handle(req, res) {
      const requestedOrigin = `http://${req.headers.host}`;
      if (![origin, crossOrigin].includes(requestedOrigin)) { res.writeHead(400).end(); return; }
      if (req.method === "POST" && req.url === "/dom-witness") {
        try {
          let body = "";
          for await (const chunk of req) { body += chunk; assert.ok(Buffer.byteLength(body) <= 16000); }
          const report = validateDomInspectionReport(JSON.parse(body), nonce);
          assert.equal(report.page === "cross" ? crossOrigin : origin, requestedOrigin);
          const before = latest.get(report.page);
          assert.ok(!before || before.pageNonce === report.pageNonce && report.serial > before.serial && report.stage >= before.stage,
            "Do not silently accept document replacement or reordered reports.");
          assert.ok(reports.length < maxReports, "Witness journal capacity exhausted.");
          reports.push({ ...report, received_ms: Date.now() }); latest.set(report.page, report);
          res.writeHead(204).end();
        } catch { rejected++; res.writeHead(400).end(); }
        return;
      }
      const page = paths.get(req.url);
      if (req.method !== "GET" || !page || (page === "cross" ? crossOrigin : origin) !== requestedOrigin) { res.writeHead(404).end(); return; }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
        "Content-Security-Policy": `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-src ${origin} ${crossOrigin}; base-uri 'none'; form-action 'none'` });
      res.end(html.get(req.url));
    },
  };
}
