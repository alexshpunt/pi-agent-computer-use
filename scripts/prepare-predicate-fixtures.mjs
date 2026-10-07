import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

// Saved, reviewed pixels only: no capture, browser source, or model inference.
const [frames, synthetic, output] = process.argv.slice(2);
if (!frames || !synthetic || !output || !path.resolve(output).startsWith(path.resolve(".tmp") + path.sep))
  throw Error("Usage: node scripts/prepare-predicate-fixtures.mjs FRAMES SYNTHETIC .tmp/OUTPUT");
await mkdir(output,{recursive:true});
const dataset = JSON.parse(await readFile("docs/evidence/mole-classifier/dataset.json","utf8"));
const cases = [];
const mole = "a cartoon mole animal popping out of green grass";
const crop = tile => { const column = (tile-1)%4, row = Math.floor((tile-1)/4);
  const left = Math.round(72+column*89.5), top = Math.round(73+row*89.5);
  return {left,top,width:Math.round(72+column*89.5+86)-left,height:Math.round(73+row*89.5+86)-top}; };
const add = async (name, bytes, condition, threshold, uncertainty, expected, provenance) => {
  const file = path.join(output,name+".png"); await writeFile(file,bytes);
  cases.push({name,file,condition,threshold,uncertainty,expected,sha256:createHash("sha256").update(bytes).digest("hex"),provenance});
};
// Threshold .309, band .005 selected from the prior synthetic calibration,
// not from these four evaluation frames or their cell scores.
for (const [frame,tile] of [["capture-004.jpg",3],["capture-012.jpg",11],["capture-017.jpg",6],["capture-020.jpg",3]]) {
  const bytes = await readFile(path.join(frames,frame));
  const hash = createHash("sha256").update(bytes).digest("hex");
  const recorded = dataset.frames.find(item=>item.frame===frame);
  if (!recorded || recorded.sha256!==hash) throw Error("Saved frame identity mismatch");
  for (const [label,cell,expected] of [["positive",tile,true],["grass",1,false]]) {
    const pixels = await sharp(bytes).extract(crop(cell)).png().toBuffer();
    await add(frame.replace(".jpg","")+"-"+label,pixels,mole,.309,.005,expected,{frame,cell,source_sha256:hash,kind:"existing evaluation frame"});
  }
}
const board = await readFile(path.join(synthetic,"capture-000.png"));
if (createHash("sha256").update(board).digest("hex")!=="770bcc817735379253ec5c89f461b7ae63592e90d29e1b3c861ef0046e1ccaaf") throw Error("Synthetic source identity mismatch");
for (const [name,tile,condition,threshold,uncertainty,expected] of [
  ["stump-not-mole",6,mole,.309,.005,false],
  ["ball-not-mole",8,mole,.309,.005,false],
  ["ball",8,"an orange ball on green grass",.32,.01,true],
  ["not-ball",10,"an orange ball on green grass",.32,.01,false],
  ["uncertain-log",5,"a wooden log on green grass",.269,.015,null]]) {
  const pixels = await sharp(board).extract(crop(tile)).flop().png().toBuffer();
  await add(name,pixels,condition,threshold,uncertainty,expected,{cell:tile,kind:"mirrored known synthetic control; not independent holdout"});
}
await writeFile(path.join(output,"cases.json"),JSON.stringify(cases,null,2)+"\n");
const first = await readFile(cases[0].file);
await writeFile(path.join(output,"image-block.json"),JSON.stringify({type:"image",data:first.toString("base64"),mimeType:"image/png"})+"\n");
await sharp({create:{width:344,height:Math.ceil(cases.length/4)*86,channels:3,background:"white"}}).composite(
  cases.map((item,index)=>({input:item.file,left:(index%4)*86,top:Math.floor(index/4)*86}))
).png().toFile(path.join(output,"contact.png"));
console.log(JSON.stringify({output,cases:cases.length,evaluation_frames:4,second_condition_limit:"known synthetic controls"}));
