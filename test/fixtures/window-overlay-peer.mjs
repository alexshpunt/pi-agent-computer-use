import { appendFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
const [record, mode] = process.argv.slice(2);
writeFileSync(record, JSON.stringify({ kind: "started", pid: process.pid }) + "\n");
console.log(JSON.stringify({ status: "ready", generation: 0, protocol_version: mode === "legacy" ? undefined : 2, capture_affinity: mode === "bad-ready" ? 0 : 17, pid: process.pid, overlay_hwnd: 42 }));
createInterface({ input: process.stdin }).on("line", line => {
  const request = JSON.parse(line); appendFileSync(record, line + "\n");
  if (mode === "bad-reply") console.log("{invalid");
  else console.log(JSON.stringify({ generation: request.generation, status: request.kind === "flash" ? "shown" : "hidden" }));
}).on("close", () => { appendFileSync(record, JSON.stringify({ kind: "eof" }) + "\n"); });
