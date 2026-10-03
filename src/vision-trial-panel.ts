/** A local image-only reading exercise. Expected strings never enter the page. */
export const visionTrialPanel = `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Vision reading trial</title><link rel="stylesheet" href="trial.css">
<main><header><h1>Vision reading trial</h1><a href="./">Vision debug</a></header>
<p>Two columns, twelve independent random strings: white background on the left, dark on the right. Enter only the text, without its row number. Apply checks exact matches and starts a fresh trial.</p>
<p id="sample-status" role="status">Loading sample…</p>
<img id="sample" alt="Six light rows and six dark rows; answers are available only as pixels" width="980" height="480">
<form id="trial-form"><div class="answers" id="answers"></div>
<div class="settings">
<label>Downsampling<select id="kernel"><option value="lanczos2">Lanczos2</option><option value="lanczos3">Lanczos3</option><option value="mitchell">Mitchell</option><option value="mks2021" selected>MKS2021</option></select></label>
<label>Max long edge (px)<input id="long-edge" type="number" min="64" max="4096" step="1" value="500" required></label>
<label>Scale slider<input id="scale" type="range" min="0.05" max="1" step="any" value="1"><output id="cap"></output></label>
<label>Scale exact<input id="scale-number" type="number" min="0.05" max="1" step="any" value="1" required></label>
<button id="apply" type="submit" disabled>Apply: check and new trial</button></div></form>
<section><h2>Previous results</h2><p id="result" role="status">No answers checked yet.</p><div id="history"></div></section>
<p class="muted">Font sizes refer to the 980×480 source PNG. Display fitting and the full viewport affect the final agent pixels. Empty or different strings fail the exact comparison, including case and spaces. Use Apply without a capture, then a fresh image-only observation: the action began with the previous settings.</p>
</main><script src="trial.js"></script></html>`;

export const visionTrialStyle = `
:root{font:15px/1.4 system-ui;color-scheme:dark;background:#111722;color:#e6edf7}
*{box-sizing:border-box}body{margin:0}main{max-width:1100px;margin:auto;padding:16px}header{display:flex;align-items:center;justify-content:space-between}h1{font-size:24px;margin:0}h2{font-size:19px;margin:12px 0 6px}a{color:#89c6ff}p{margin:8px 0}
#sample{display:block;width:min(980px,100%);height:auto;background:white;min-height:120px}.answers{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px 16px;margin:14px 0}.row{display:flex;flex-direction:column;gap:3px}.row label{font-size:13px}.settings{display:flex;gap:12px;flex-wrap:wrap;align-items:end}.settings label{display:flex;flex-direction:column;gap:4px}select,input,button{font:inherit;color:inherit;background:#1b2432;border:1px solid #566b89;border-radius:5px;padding:6px;min-width:0}input[type=range]{width:170px}input[type=number]{width:130px}button{cursor:pointer;background:#24446b}button:disabled{opacity:.6}#result{color:#bbe3c6}.muted,#history,#sample-status{color:#aebbd0;font-size:13px}#history p{margin:4px 0}
`;

export const visionTrialScript = `
const byId=id=>document.getElementById(id);
const sizes=[28,20,16,12,10,8];let current,busy=false;
for(let index=0;index<6;index++)for(const column of [0,1]){
  const number=index+1+column*6;
  const row=document.createElement("div");row.className="row";
  const label=document.createElement("label");label.htmlFor="answer-"+number;label.textContent=(column?"Dark":"Light")+" row "+(index+1)+" · source "+sizes[index]+" px";
  const input=document.createElement("input");input.id=label.htmlFor;input.maxLength=200;input.autocomplete="off";input.spellcheck=false;
  row.append(label,input);byId("answers").append(row);
}
function draft(){return {kernel:byId("kernel").value,maxLongEdge:Number(byId("long-edge").value),scale:Number(byId("scale-number").value)}}
function showCap(){const value=draft();byId("cap").textContent=value.scale+" × "+value.maxLongEdge+" = "+Math.floor(value.scale*value.maxLongEdge)+" px"}
for(const id of ["kernel","long-edge"])byId(id).addEventListener("input",showCap);
byId("scale").addEventListener("input",()=>{byId("scale-number").value=byId("scale").value;showCap()});
byId("scale-number").addEventListener("input",()=>{byId("scale").value=byId("scale-number").value;showCap()});
async function showSample(sample){
  byId("sample-status").textContent="Loading new random sample…";
  byId("sample").removeAttribute("src");
  const image=byId("sample");image.src="trial/pixels/"+sample.id;await image.decode();
  current=sample;
  byId("kernel").value=sample.configuration.kernel;byId("long-edge").value=sample.configuration.maxLongEdge;
  byId("scale").value=sample.configuration.scale;byId("scale-number").value=sample.configuration.scale;showCap();
  for(let row=1;row<=12;row++)byId("answer-"+row).value="";
  document.title="Vision trial "+sample.id;
  byId("sample-status").textContent="Ready · trial "+sample.id+" · settings v"+sample.configuration.version;
}
function showResult(result){
  const light=result.rows.filter(row=>row.background==="light"&&row.status==="correct").length;
  const dark=result.rows.filter(row=>row.background==="dark"&&row.status==="correct").length;
  const line="Trial "+result.trial+" · "+result.configuration.kernel+" / cap "+Math.floor(result.configuration.maxLongEdge*result.configuration.scale)+" · Light "+light+"/6, Dark "+dark+"/6: "+result.rows.map(row=>row.background+" "+((row.row-1)%6+1)+" "+row.status).join(" · ");
  byId("result").textContent=line;const previous=document.createElement("p");previous.textContent=line;byId("history").prepend(previous);
  while(byId("history").children.length>16)byId("history").lastChild.remove();
}
byId("trial-form").addEventListener("submit",async event=>{
  event.preventDefault();if(busy||!current)return;busy=true;byId("apply").disabled=true;
  const submission={trial:current.id,settings:draft(),answers:Array.from({length:12},(_,index)=>({row:index+1,text:byId("answer-"+(index+1)).value}))};
  try{
    const response=await fetch("trial/apply",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(submission)});
    if(!response.ok)throw Error(await response.text());
    const applied=await response.json();current=undefined;showResult(applied.result);await showSample(applied.next);
  }catch(error){byId("sample-status").textContent="Not ready: "+error.message}
  finally{busy=false;byId("apply").disabled=!current}
});
(async()=>{try{const response=await fetch("trial/new");if(!response.ok)throw Error(await response.text());await showSample(await response.json());byId("apply").disabled=false}catch(error){byId("sample-status").textContent="Not ready: "+error.message}})();
`;
