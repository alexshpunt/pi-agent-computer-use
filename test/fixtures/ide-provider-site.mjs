import http from "node:http";
import { randomBytes } from "node:crypto";

const eventTypes = ["keydown", "keyup", "beforeinput", "input", "mousedown", "mouseup", "click", "dblclick", "contextmenu", "wheel", "dragstart", "drag", "dragend", "drop", "pointerdown", "pointerup"];
const forbiddenTypes = ["dblclick", "contextmenu", "wheel", "dragstart", "drag", "dragend", "drop"];
const maxEvents = 4096;
const maxValueLength = 8192;
const freshForMs = 1500;
const plainObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
const counter = value => Number.isSafeInteger(value) && value >= 0;

/** Serve two disposable pages and record independent browser witnesses, never computer input. */
export async function createIdeProviderSite() {
  const tokens = [randomBytes(24).toString("hex"), randomBytes(24).toString("hex")];
  const reports = [null, null], events = [[], []], eventIds = [new Set(), new Set()];
  const dropped = [0, 0], rejected = [0, 0];
  const html = index => `<!doctype html><meta charset="utf-8"><title>Pi IDE computer ${index ? "sentinel" : "target"}</title>
<style>
body{font:18px system-ui;margin:24px;background:${index ? "#efe6ff" : "#e1efff"};color:#182431}
h1{font-size:23px;margin:0 0 16px}label{display:block;margin-bottom:8px}textarea{box-sizing:border-box;width:100%;height:180px;font:18px ui-monospace,monospace;padding:12px;resize:none;background:white}
button{font:inherit;padding:12px 24px;margin-top:18px}#count{font:24px ui-monospace,monospace;margin-top:16px}p{max-width:34em}
</style>
<h1>IDE computer ${index ? "sentinel" : "target"}</h1>
<label for="literal">Literal text field</label><textarea id="literal" aria-label="Literal text field" spellcheck="false" autocomplete="off"></textarea>
<button id="count-action" type="button" aria-label="Count action">Count action</button>
<div id="count" role="status" aria-live="polite">Count: 0</div>
<p>Disposable localhost fixture. No accounts, real documents or external requests.</p>
<script>
const index=${index},token=${JSON.stringify(tokens[index])};
const types=${JSON.stringify(eventTypes)},forbiddenTypes=${JSON.stringify(forbiddenTypes)};
const field=document.getElementById('literal'),button=document.getElementById('count-action'),countLabel=document.getElementById('count');
let reportSerial=0,eventSerial=0,count=0;
const counts=Object.fromEntries(types.map(type=>[type,0]));
const forbidden=Object.fromEntries([...forbiddenTypes,'keys_outside_field'].map(type=>[type,0]));
function send(path,value){fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...value,token})}).catch(()=>{});}
function report(){send('/report/'+index,{serial:++reportSerial,time:Date.now(),value:field.value,count,counts:{...counts},forbidden:{...forbidden},has_focus:document.hasFocus(),focus:document.activeElement.id||document.activeElement.tagName});}
for(const type of types)document.addEventListener(type,event=>{
  if(event.isTrusted){counts[type]++;if(type in forbidden)forbidden[type]++;if((type==='keydown'||type==='keyup')&&event.target!==field)forbidden.keys_outside_field++;}
  send('/event/'+index,{serial:++eventSerial,time:performance.timeOrigin+performance.now(),type,target:event.target.id||event.target.tagName,trusted:event.isTrusted,key:event.key??null,button:event.button??null,buttons:event.buttons??null,text_length:field.value.length});
  report();
},{capture:true});
button.addEventListener('click',event=>{if(!event.isTrusted)return;count++;countLabel.textContent='Count: '+count;report();});
report();setInterval(report,100);
</script>`;

  const server = http.createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    const path = new URL(request.url, "http://localhost").pathname;
    if (request.method === "GET" && /^\/[01]$/.test(path)) {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(html(Number(path.slice(1)))); return;
    }
    const match = /^\/(report|event)\/([01])$/.exec(path);
    if (request.method !== "POST" || !match) { response.writeHead(404).end(); return; }
    const index = Number(match[2]);
    let body = "";
    for await (const chunk of request) {
      body += chunk;
      if (Buffer.byteLength(body) > 65536) { rejected[index]++; response.writeHead(413).end(); return; }
    }
    try {
      const value = JSON.parse(body);
      if (!plainObject(value) || value.token !== tokens[index] || !counter(value.serial) || value.serial < 1 ||
        !Number.isFinite(value.time) || value.time <= 0) throw Error("Invalid witness identity or timestamp.");
      const received_ms = Date.now();
      if (match[1] === "report") {
        if (typeof value.value !== "string" || value.value.length > maxValueLength || !counter(value.count) ||
          typeof value.has_focus !== "boolean" || typeof value.focus !== "string" || value.focus.length > 128 ||
          !plainObject(value.counts) || !eventTypes.every(type => counter(value.counts[type])) ||
          Object.keys(value.counts).some(type => !eventTypes.includes(type)) || !plainObject(value.forbidden) ||
          ![...forbiddenTypes, "keys_outside_field"].every(type => counter(value.forbidden[type])) ||
          Object.keys(value.forbidden).some(type => ![...forbiddenTypes, "keys_outside_field"].includes(type))) throw Error("Invalid report fields.");
        if (reports[index] && (value.serial <= reports[index].serial || value.time < reports[index].time)) {
          rejected[index]++; response.writeHead(409).end(); return;
        }
        reports[index] = { serial: value.serial, time: value.time, received_ms, value: value.value, count: value.count,
          counts: { ...value.counts }, forbidden: { ...value.forbidden }, has_focus: value.has_focus, focus: value.focus };
      } else {
        if (!eventTypes.includes(value.type) || typeof value.target !== "string" || value.target.length > 128 ||
          typeof value.trusted !== "boolean" || !(value.key === null || typeof value.key === "string" && value.key.length <= 128) ||
          !(value.button === null || Number.isSafeInteger(value.button) && value.button >= -1 && value.button <= 5) ||
          !(value.buttons === null || counter(value.buttons) && value.buttons <= 31) ||
          !counter(value.text_length) || value.text_length > maxValueLength) throw Error("Invalid event fields.");
        if (eventIds[index].has(value.serial)) { rejected[index]++; response.writeHead(409).end(); return; }
        if (events[index].length >= maxEvents) { dropped[index]++; response.writeHead(413).end(); return; }
        eventIds[index].add(value.serial);
        events[index].push({ serial: value.serial, time: value.time, received_ms, type: value.type, target: value.target,
          trusted: value.trusted, key: value.key, button: value.button, buttons: value.buttons, text_length: value.text_length });
      }
      response.writeHead(204).end();
    } catch { rejected[index]++; response.writeHead(400).end(); }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    /** Snapshot witnesses without UI effects; old reports are explicitly stale rather than current state. */
    state() {
      const measured_ms = Date.now();
      return structuredClone({ measured_ms, reports: reports.map(report => report && { ...report,
        age_ms: measured_ms - report.received_ms, fresh: measured_ms - report.received_ms <= freshForMs }),
      events: events.map(rows => [...rows].sort((a, b) => a.serial - b.serial)), dropped, rejected,
      limits: { max_events: maxEvents, max_value_length: maxValueLength, fresh_for_ms: freshForMs } });
    },
    close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}
