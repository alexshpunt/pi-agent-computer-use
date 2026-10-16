import assert from "node:assert/strict";
import { MARKERS } from "../dom-marker-geometry.mjs";

/** Synthetic page only; its script reports readonly CSS boxes and retained input evidence. */
export function createDomPixelPage({ title, nonce, cssomMarkers = false }) {
  assert.match(nonce, /^[a-f0-9-]{36}$/);
  assert.equal(title, `Pi DOM pixel proof ${nonce.slice(0, 8)}`);
  assert.equal(typeof cssomMarkers, "boolean");
  return `<!doctype html><meta charset="utf-8"><title>${title}</title>
<style>html{background:#f4e7d1}body{margin:0;font:24px sans-serif;color:#172638}.pattern{height:160px;background:repeating-linear-gradient(90deg,#d73b42 0 17px,#235db1 17px 39px,#53a568 39px 62px,#ffcd45 62px 83px)}main{margin:31px 43px;border:7px solid #934aad;padding:29px;background:#f9fcff}aside{height:90px;background:linear-gradient(37deg,#25599b,#fccb38)}</style>
${cssomMarkers ? MARKERS.map(marker => `<div id="${marker.id}" data-testid="${marker.id}" style="position:absolute;left:${marker.css.x}px;top:${marker.css.y}px;width:${marker.css.width}px;height:${marker.css.height}px;background:rgb(${marker.color.join(",")});z-index:10"></div>`).join("") : ""}
<div class="pattern"></div><main><h1>Original native pixels</h1><p>Static owned page: ${nonce}</p><p>Readonly proof, no input.</p><aside></aside></main>
<script>const documentId=crypto.randomUUID(),events=[];for(const type of ['keydown','keyup','beforeinput','input','mousedown','mouseup','pointerdown','pointerup','wheel','click'])document.addEventListener(type,e=>{if(events.length<32)events.push({type,trusted:e.isTrusted})},true);
function send(){fetch('/witness',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({nonce:${JSON.stringify(nonce)},documentId,events,location:location.href,viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio,scrollX,scrollY},${cssomMarkers ? `markers:${JSON.stringify(MARKERS.map(marker => marker.id))}.map(id=>{const r=document.getElementById(id).getBoundingClientRect();return {id,bounds:{x:r.x,y:r.y,width:r.width,height:r.height}}})` : ""}})}).catch(()=>{})}send();setInterval(send,300);</script>`;
}
