import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import { startOverlayPeer } from "../src/window-overlay-peer.ts";

for (const mode of ["normal", "bad-ready", "bad-reply"]) test(`rendering pipe ${mode}: exact replies or fail-soft EOF, never replay`, async () => {
  await mkdir(".tmp/qt-overlay", { recursive: true });
  const cwd = await mkdtemp(path.resolve(".tmp/qt-overlay/peer-")); const record = path.join(cwd, "calls.jsonl");
  try {
    const start = () => startOverlayPeer(process.execPath, [path.resolve("test/fixtures/window-overlay-peer.mjs"), record, mode]);
    if (mode === "bad-ready") await expect(start()).rejects.toThrow("protocol");
    else {
      const peer = await start();
      const hide = peer.send({ kind: "hide", generation: 1 });
      if (mode === "bad-reply") await expect(hide).rejects.toThrow("protocol");
      else expect(await hide).toEqual({ status: "hidden", generation: 1 });
      await peer.close(); await peer.close();
    }
    const calls = (await readFile(record, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(calls.filter(c => c.kind === "hide")).toHaveLength(mode === "bad-ready" ? 0 : 1);
    expect(calls.at(-1)).toEqual({ kind: "eof" });
    expect(() => process.kill(calls[0].pid, 0)).toThrow();
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
