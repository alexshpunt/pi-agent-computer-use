import assert from "node:assert/strict";

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const eventTypes = ["click", "dblclick", "contextmenu", "pointerover", "mouseover", "pointerenter", "mouseenter", "focus", "blur", "keydown", "keyup", "beforeinput", "input", "change", "pointerdown", "pointerup", "mousedown", "mouseup", "wheel"];
const targets = ["", "value", "checked", "selected", "primary", "double", "context", "hover", "press", "shadow", "shadow-choice", "duplicate-a", "duplicate-b", "async-arm", "async-target", "async-slot", "result", "far", "disabled", "hidden"];
const counterKeys = ["primary", "double", "context", "hover", "press", "shadow", "duplicateA", "duplicateB", "async", "disabled", "hidden"];
const stages = { idle: 0, armed: 0, inserted: 1, replaced: 2, ready: 2 };
const activityLimit = 1000000;
function keys(value, expected) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort());
}
function loopbackOrigin(value) {
  const url = new URL(value);
  assert.equal(url.protocol, "http:"); assert.equal(url.hostname, "127.0.0.1");
  assert.ok(url.port && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash);
  return url.origin;
}

/** Validate one bounded independent page witness; event delivery is not application success. */
export function validateDomActionReport(report, nonce) {
  keys(report, ["nonce", "pageNonce", "serial", "events", "eventOverflow", "counters", "state", "activity"]);
  assert.equal(report.nonce, nonce); assert.match(report.pageNonce, uuid);
  assert.ok(Number.isSafeInteger(report.serial) && report.serial >= 1 && report.serial <= 1200);
  assert.ok(Array.isArray(report.events) && report.events.length <= 128);
  assert.equal(typeof report.eventOverflow, "boolean");
  assert.ok(!report.eventOverflow || report.events.length === 128);
  for (const event of report.events) {
    keys(event, ["type", "trusted", "target"]);
    assert.ok(eventTypes.includes(event.type) && targets.includes(event.target) && typeof event.trusted === "boolean");
  }
  keys(report.counters, counterKeys);
  assert.ok(Object.values(report.counters).every(value => Number.isSafeInteger(value) && value >= 0 && value <= 10000));
  keys(report.state, ["value", "checked", "selected", "active", "asyncStage", "asyncGeneration"]);
  const state = report.state;
  assert.ok(typeof state.value === "string" && [...state.value].length <= 2000 && !state.value.includes("\0"));
  assert.equal(typeof state.checked, "boolean");
  assert.ok(["first", "second", "third"].includes(state.selected) && targets.includes(state.active));
  assert.ok(Object.hasOwn(stages, state.asyncStage) && state.asyncGeneration === stages[state.asyncStage]);
  // These are document activity samples, never compositor or native-paint evidence.
  keys(report.activity, ["visibilityState", "hasFocus", "animationFrames", "animationOverflow", "sampledAtMs"]);
  const activity = report.activity;
  assert.ok(["visible", "hidden"].includes(activity.visibilityState));
  assert.equal(typeof activity.hasFocus, "boolean");
  assert.ok(Number.isSafeInteger(activity.animationFrames) && activity.animationFrames >= 0 && activity.animationFrames <= activityLimit);
  assert.equal(typeof activity.animationOverflow, "boolean");
  assert.ok(!activity.animationOverflow || activity.animationFrames === activityLimit);
  assert.ok(Number.isFinite(activity.sampledAtMs) && activity.sampledAtMs >= 0 && activity.sampledAtMs <= activityLimit);
  assert.ok(Buffer.byteLength(JSON.stringify(report)) <= 24000);
  return structuredClone(report);
}

function pageHtml(nonce) {
  return `<!doctype html><meta charset="utf-8"><title>Pi DOM actions ${nonce}</title>
<style>body{font:18px sans-serif;margin:18px}button,input,select{font:inherit;margin:6px;padding:6px}#shadow{padding:10px;background:#eef}#hidden{display:none}#hover:hover{background:#fc8}#far{margin-top:1000px}</style>
<h1>DOM action fixture</h1><p>Run ${nonce}</p>
<label for="value">Value field</label><input id="value" data-testid="value" value="initial" maxlength="2000">
<label><input id="checked" data-testid="checked" type="checkbox">Checked choice</label>
<select id="selected" data-testid="selected" aria-label="Selected choice"><option value="first">First</option><option value="second">Second</option><option value="third">Third</option></select>
<p><button id="primary" data-testid="primary">Primary action</button><button id="double" data-testid="double">Double action</button><button id="context" data-testid="context">Context action</button><button id="hover" data-testid="hover">Hover action</button><button id="press" data-testid="press">Key action</button></p>
<p><button id="duplicate-a" aria-label="Duplicate choice">First duplicate</button><button id="duplicate-b" aria-label="Duplicate choice">Second duplicate</button><button id="disabled" data-testid="disabled" disabled>Disabled action</button><button id="hidden" data-testid="hidden">Hidden action</button></p>
<div id="shadow"></div><p><button id="async-arm" data-testid="async-arm">Arm async once</button><span id="async-slot"></span></p>
<output id="result" aria-live="polite"></output><p id="far">Scroll destination</p>
<script src="/fixture.js"></script>`;
}

function pageScript(nonce) {
  return `const nonce=${JSON.stringify(nonce)},pageNonce=crypto.randomUUID(),events=[],counters=Object.fromEntries(${JSON.stringify(counterKeys)}.map(key=>[key,0]));
const byId=id=>document.getElementById(id),shadow=byId('shadow').attachShadow({mode:'open'});
shadow.innerHTML='<button id="shadow-choice" data-testid="shadow-choice">Shadow action</button>';
let serial=0,eventOverflow=false,pending=false,ended=false,asyncStage='idle',asyncGeneration=0;
const activityStartedAt=performance.now();let animationFrames=0,animationOverflow=false,animationRequest=null;
function stopActivity(){ended=true;if(animationRequest!==null)cancelAnimationFrame(animationRequest);}
function animationFrame(){
 if(ended)return;animationFrames++;
 if(animationFrames>=${activityLimit}){animationOverflow=true;return;}
 animationRequest=requestAnimationFrame(animationFrame);
}
animationRequest=requestAnimationFrame(animationFrame);
function effect(key){counters[key]++;byId('result').textContent=key+' '+counters[key];queueMicrotask(send);}
for(const [id,key,type] of [['primary','primary','click'],['double','double','dblclick'],['context','context','contextmenu'],['hover','hover','mouseenter'],['press','press','keydown'],['duplicate-a','duplicateA','click'],['duplicate-b','duplicateB','click'],['disabled','disabled','click'],['hidden','hidden','click']])
 byId(id).addEventListener(type,event=>{if(type==='contextmenu')event.preventDefault();effect(key);});
shadow.querySelector('button').onclick=()=>effect('shadow');
function record(event){
 const target=event.composedPath()[0],id=String(target.id||'');
 if(events.length<128)events.push({type:event.type,trusted:event.isTrusted,target:id});else eventOverflow=true;
 queueMicrotask(send);
}
for(const type of ${JSON.stringify(eventTypes)}) {
 document.addEventListener(type,record,true);
 shadow.addEventListener(type,event=>{if(!event.composed)record(event);},true);
}
byId('async-arm').onclick=()=>{
 if(ended||asyncStage!=='idle')return;asyncStage='armed';send();
 setTimeout(()=>{if(ended)return;const node=document.createElement('button');node.id='async-target';node.dataset.testid='async-target';node.textContent='Async generation 1';node.disabled=true;
 node.onclick=()=>effect('async');byId('async-slot').append(node);asyncStage='inserted';asyncGeneration=1;send();},2000);
 setTimeout(()=>{if(ended)return;const old=byId('async-target'),node=old.cloneNode(true);node.textContent='Async generation 2';node.onclick=()=>effect('async');old.replaceWith(node);asyncStage='replaced';asyncGeneration=2;send();},3000);
 setTimeout(()=>{if(ended)return;byId('async-target').disabled=false;asyncStage='ready';send();},4000);
};
async function send(){
 if(ended||pending)return;if(serial>=1200){stopActivity();return;}pending=true;
 const state={value:byId('value').value,checked:byId('checked').checked,selected:byId('selected').value,active:String((shadow.activeElement||document.activeElement)?.id||''),asyncStage,asyncGeneration};
 const activity={visibilityState:document.visibilityState,hasFocus:document.hasFocus(),animationFrames,animationOverflow,sampledAtMs:performance.now()-activityStartedAt};
 try{await fetch('/dom-action-witness',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({nonce,pageNonce,serial:++serial,events,eventOverflow,counters,state,activity})});}catch{}finally{pending=false;}
}
send();const interval=setInterval(send,500);setTimeout(()=>{stopActivity();clearInterval(interval);},600000);
`;
}

/**
 * Create a loopback-only page and independent witness journal without launching a browser.
 * Reports are copied on read; rejected/overflow status or stale reports are not clean acceptance.
 */
export function createDomActionPages({ nonce, origin, maxReports = 1200 }) {
  assert.match(nonce, uuid); origin = loopbackOrigin(origin);
  assert.ok(Number.isInteger(maxReports) && maxReports >= 1 && maxReports <= 1200);
  const html = pageHtml(nonce), script = pageScript(nonce), reports = [];
  let latest, rejected = 0, overflow = false;
  return {
    reports: () => structuredClone(reports),
    status: () => ({ count: reports.length, rejected, capacity: maxReports, overflow }),
    async handle(req, res) {
      const requestedOrigin = `http://${req.headers.host}`;
      if (req.method === "POST" && req.url === "/dom-action-witness") {
        try {
          assert.equal(requestedOrigin, origin); assert.equal(req.headers.origin, origin);
          assert.equal(req.headers["content-type"]?.split(";")[0].trim(), "application/json");
          req.setEncoding("utf8");
          let body = "";
          for await (const chunk of req) { body += chunk; assert.ok(Buffer.byteLength(body) <= 24000); }
          const report = validateDomActionReport(JSON.parse(body), nonce);
          if (latest) {
            assert.equal(report.pageNonce, latest.pageNonce); assert.ok(report.serial > latest.serial);
            assert.deepEqual(report.events.slice(0, latest.events.length), latest.events);
            assert.ok(!latest.eventOverflow || report.eventOverflow);
            assert.ok(counterKeys.every(key => report.counters[key] >= latest.counters[key]));
            assert.ok(report.activity.animationFrames >= latest.activity.animationFrames);
            assert.ok(report.activity.sampledAtMs >= latest.activity.sampledAtMs);
            assert.ok(!latest.activity.animationOverflow || report.activity.animationOverflow);
            const order = Object.keys(stages);
            assert.ok(order.indexOf(report.state.asyncStage) >= order.indexOf(latest.state.asyncStage));
          }
          if (reports.length >= maxReports) { overflow = true; throw Error("Witness capacity exhausted."); }
          reports.push({ ...report, received_ms: Date.now() }); latest = report;
          res.writeHead(204).end();
        } catch { rejected++; req.resume(); res.writeHead(400).end(); }
        return;
      }
      if (requestedOrigin !== origin) { res.writeHead(400).end(); return; }
      if (req.method !== "GET" || !["/", "/fixture.js"].includes(req.url)) { res.writeHead(404).end(); return; }
      const isScript = req.url === "/fixture.js";
      res.writeHead(200, { "Content-Type": isScript ? "text/javascript; charset=utf-8" : "text/html; charset=utf-8", "Cache-Control": "no-store",
        "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'" });
      res.end(isScript ? script : html);
    },
  };
}
