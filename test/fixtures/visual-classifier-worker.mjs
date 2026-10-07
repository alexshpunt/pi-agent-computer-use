import readline from "node:readline";
const conditions = new Set();
for await (const line of readline.createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.condition === "wait") { await new Promise(resolve => setTimeout(resolve, 5000)); }
  if (request.condition === "worker error") {
    console.log(JSON.stringify({ id: request.id, error: "Fixture error" })); continue;
  }
  console.log(JSON.stringify({ id: request.id, score: .4, cache_hit: conditions.has(request.condition), inference_ms: 1, load_ms: conditions.size ? 0 : 2 }));
  conditions.add(request.condition);
}
