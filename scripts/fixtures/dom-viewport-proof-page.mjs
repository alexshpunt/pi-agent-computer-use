import assert from "node:assert/strict";

/** Fixed document-CSS boxes. Geometry is declared before any native pixels exist. */
export const VIEWPORT_MARKERS = Object.freeze([
  { id: "raster-black", rgb: 0, x: 80, y: 150, width: 24, height: 24 },
  { id: "raster-white", rgb: 255, x: 360, y: 240, width: 24, height: 24 },
  { id: "raster-fractional-black", rgb: 0, x: 130.25, y: 340.5, width: 24.5, height: 23.75 },
  { id: "raster-fractional-white", rgb: 255, x: 500.5, y: 420.25, width: 25.25, height: 24.5 },
].map(Object.freeze));
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const eventTypes = ["keydown", "keyup", "beforeinput", "input", "change", "mousedown", "mouseup", "pointerdown", "pointerup", "wheel", "click", "dblclick", "contextmenu", "pointerover", "pointerenter", "mouseover", "mouseenter", "focus", "blur"];
const keys = (value, expected) => {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort());
};

/** Fixed external script; no caller-supplied URL, code, timing or stylesheet. */
export function createViewportProofPage(nonce) {
  assert.match(nonce, uuid);
  const html = `<!doctype html><meta charset="utf-8"><title>Pi viewport proof ${nonce}</title>
<style>html,body{margin:0;padding:0;background:#888;scroll-behavior:auto}body{height:1200px}h1{font:16px sans-serif;position:absolute;top:8px;left:16px}</style>
<h1>Readonly viewport proof ${nonce}</h1>
${VIEWPORT_MARKERS.map(m => `<div id="${m.id}" data-testid="${m.id}" style="position:absolute;left:${m.x}px;top:${m.y}px;width:${m.width}px;height:${m.height}px;background:rgb(${m.rgb},${m.rgb},${m.rgb})"></div>`).join("\n")}
<script src="/fixture.js"></script>`;
  const script = `const nonce=${JSON.stringify(nonce)},documentId=crypto.randomUUID(),events=[];let serial=0,stage=0,overflow=false,pending=false,ended=false;
for(const type of ${JSON.stringify(eventTypes)})document.addEventListener(type,event=>{if(events.length<64)events.push({type,trusted:event.isTrusted});else overflow=true;},true);
async function send(){if(ended||pending)return;if(serial>=500){ended=true;return;}pending=true;
const markers=${JSON.stringify(VIEWPORT_MARKERS.map(m => m.id))}.map(id=>{const r=document.getElementById(id).getBoundingClientRect();return{id,bounds:{x:r.x,y:r.y,width:r.width,height:r.height}}});
try{await fetch('/witness',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({nonce,documentId,serial:++serial,stage,events,overflow,location:location.href,viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio,scrollX,scrollY,visual:{offset_x:visualViewport.offsetLeft,offset_y:visualViewport.offsetTop,page_x:visualViewport.pageLeft,page_y:visualViewport.pageTop,width:visualViewport.width,height:visualViewport.height,scale:visualViewport.scale}},markers})});}catch{}finally{pending=false;}}
send();const interval=setInterval(send,250);setTimeout(()=>{scrollTo(0,100);stage=1;send();},60000);setTimeout(()=>{ended=true;clearInterval(interval);},120000);
`;
  return { html, script };
}

/** Validate closed, bounded independent evidence, including the declared marker positions. */
export function validateViewportReport(report, nonce, url) {
  keys(report, ["nonce", "documentId", "serial", "stage", "events", "overflow", "location", "viewport", "markers"]);
  assert.equal(report.nonce, nonce); assert.match(report.documentId, uuid);
  assert.equal(report.location, url);
  assert.ok(Number.isSafeInteger(report.serial) && report.serial >= 1 && report.serial <= 500);
  assert.ok([0, 1].includes(report.stage)); assert.equal(report.overflow, false);
  assert.ok(Array.isArray(report.events) && report.events.length <= 64);
  for (const event of report.events) {
    keys(event, ["type", "trusted"]);
    assert.ok(eventTypes.includes(event.type)); assert.equal(typeof event.trusted, "boolean");
  }
  keys(report.viewport, ["width", "height", "dpr", "scrollX", "scrollY", "visual"]);
  const v = report.viewport;
  assert.ok([v.width, v.height].every(n => Number.isSafeInteger(n) && n > 0 && n <= 16384));
  assert.ok(Number.isFinite(v.dpr) && v.dpr >= 0.25 && v.dpr <= 8);
  assert.equal(v.scrollX, 0); assert.equal(v.scrollY, report.stage * 100);
  keys(v.visual, ["offset_x", "offset_y", "page_x", "page_y", "width", "height", "scale"]);
  assert.ok(Object.values(v.visual).every(Number.isFinite));
  assert.equal(v.visual.offset_x, 0); assert.equal(v.visual.offset_y, 0); assert.equal(v.visual.scale, 1);
  assert.equal(v.visual.page_x, v.scrollX); assert.equal(v.visual.page_y, v.scrollY);
  assert.ok(v.visual.width > 0 && v.visual.width <= v.width && v.visual.height > 0 && v.visual.height <= v.height);
  assert.ok(Array.isArray(report.markers) && report.markers.length === VIEWPORT_MARKERS.length);
  for (const [index, marker] of VIEWPORT_MARKERS.entries()) {
    const sample = report.markers[index]; keys(sample, ["id", "bounds"]);
    assert.equal(sample.id, marker.id);
    assert.deepEqual(sample.bounds, { x: marker.x, y: marker.y - v.scrollY, width: marker.width, height: marker.height });
  }
  assert.ok(Buffer.byteLength(JSON.stringify(report)) <= 16384);
  return structuredClone(report);
}

/** Retain all setup events. Once baseline is sealed, no additional input/hover is accepted. */
export function assertViewportHistory(reports, nonce, url, rejected, baseline) {
  assert.equal(rejected, 0); assert.ok(reports.length > 0 && reports.length <= 500);
  let previous;
  for (const saved of reports) {
    const { received_ms, ...report } = saved;
    validateViewportReport(report, nonce, url); assert.ok(Number.isSafeInteger(received_ms));
    if (previous) {
      assert.equal(report.documentId, previous.documentId); assert.ok(report.serial > previous.serial);
      assert.ok(report.stage >= previous.stage);
      assert.deepEqual(report.events.slice(0, previous.events.length), previous.events, "Event prefix erased.");
      assert.deepEqual([report.viewport.width, report.viewport.height, report.viewport.dpr], [previous.viewport.width, previous.viewport.height, previous.viewport.dpr]);
    }
    if (baseline && report.serial >= baseline.serial) assert.deepEqual(report.events, baseline.events, "Input appeared after readonly baseline.");
    previous = report;
  }
  return reports.at(-1);
}
