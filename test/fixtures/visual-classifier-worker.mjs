import readline from "node:readline";
import sharp from "sharp";
const conditions = new Set();
for await (const line of readline.createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.condition === "wait") { await new Promise(resolve => setTimeout(resolve, 5000)); }
  if (request.condition === "worker error") {
    console.log(JSON.stringify({ id: request.id, error: "Fixture error" })); continue;
  }
  if (request.condition === "bad batch receipt") {
    console.log(JSON.stringify({ id: request.id, scores: [], cache_hit: false, inference_ms: 1, load_ms: 0 })); continue;
  }
  if (request.condition === "red pixel") {
    const bytes = Buffer.from(request.data, "base64");
    const scoreFor = async region => {
      let pixels = sharp(bytes);
      if (region) {
        const { x: left, y: top, width, height } = region;
        pixels = pixels.extract({ left, top, width, height });
      }
      const { data, info } = await pixels.removeAlpha().raw().toBuffer({ resolveWithObject: true });
      let red = 0;
      for (let i = 0; i < data.length; i += info.channels) if (data[i] > 200 && data[i + 1] < 50) red++;
      return red / (info.width * info.height);
    };
    const output = request.regions ? { scores: await Promise.all(request.regions.map(scoreFor)) } : { score: await scoreFor(request.region) };
    console.log(JSON.stringify({ id: request.id, ...output, cache_hit: conditions.has(request.condition), inference_ms: 1, load_ms: 0 }));
    conditions.add(request.condition); continue;
  }
  console.log(JSON.stringify({ id: request.id, score: .4, cache_hit: conditions.has(request.condition), inference_ms: 1, load_ms: conditions.size ? 0 : 2 }));
  conditions.add(request.condition);
}
