import { createServer } from "node:http";
import { randomInt } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import sharp from "sharp";

/** New synthetic page: answer text exists only in image pixels, never in page text or a JSON endpoint. */
export async function startCropFixture() {
  const digits = () => Array.from({ length: 8 }, () => randomInt(10)).join("");
  const sample = await sharp(Buffer.from(`<svg width="600" height="180"><rect width="600" height="180" fill="white"/><rect x="1" y="1" width="598" height="178" fill="none" stroke="#333"/><text x="20" y="40" font-size="16" font-family="monospace">Original pixels ${digits()}</text><text x="20" y="85" font-size="12" font-family="monospace">Small detail ${digits()}</text><text x="20" y="130" font-size="8" font-family="monospace">Fine print ${digits()}</text></svg>`)).png().toBuffer();
  const server = createServer((request, response) => {
    if (request.url === "/sample.png") { response.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "no-store" }); response.end(sample); return; }
    response.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
    response.end('<!doctype html><title>Pi original crop fixture</title><style>body{margin:0;height:2000px;background:#eee;font:20px system-ui}h1{margin:20px}#sample{position:absolute;left:100px;top:100px;width:600px;height:180px}#target{position:absolute;left:100px;top:330px;width:100px;height:80px;background:#f90;display:grid;place-items:center}#result{position:absolute;left:220px;top:340px}</style><h1>Original-frame crop</h1><img id="sample" src="/sample.png" alt="Pixel-only reading sample"><div id="target">Click here</div><p id="result">Clicks: 0</p><script>let clicks=0;document.querySelector("#target").onclick=()=>{document.querySelector("#result").textContent="Clicks: "+(++clicks);document.querySelector("#target").style.background="#5c5";};</script>');
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No fixture port");
  return { url: "http://127.0.0.1:" + address.port, close: () => new Promise(resolve => server.close(resolve)) };
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  const fixture = await startCropFixture();
  await mkdir(".tmp/crop", { recursive: true });
  await writeFile(".tmp/crop/fixture.json", JSON.stringify({ url: fixture.url }) + "\n");
  console.log(fixture.url);
  const stop = () => { void fixture.close().then(() => process.exit(0)); };
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
}
