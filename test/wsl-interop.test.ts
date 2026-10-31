import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { liveInterop } from "../src/wsl-interop.ts";

// LPT-967: a process started from a long-lived terminal can carry WSL_INTEROP of a WSL session that has closed; its
// socket is gone and every Windows command fails. A live socket of the same WSL is used instead.
const servers: Server[] = [];
let dir = "";
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))));
  if (dir) await rm(dir, { recursive: true, force: true });
});
async function socket(name: string) {
  const file = path.join(dir, name);
  const server = createServer();
  await new Promise<void>(resolve => server.listen(file, resolve));
  servers.push(server);
  return file;
}

test("a live WSL_INTEROP is kept", async () => {
  dir = await mkdtemp(path.join(tmpdir(), "interop-"));
  const own = await socket("401_interop");
  await socket("1_interop");
  expect(await liveInterop(own, dir)).toBe(own);
});

test("a dead WSL_INTEROP gives way to the lowest live socket, and nothing live gives none", async () => {
  dir = await mkdtemp(path.join(tmpdir(), "interop-"));
  const first = await socket("1_interop");
  await socket("17_interop");
  await writeFile(path.join(dir, "2_interop"), "not a socket");
  expect(await liveInterop(path.join(dir, "401_interop"), dir)).toBe(first);
  // An empty value stands for an unset variable; undefined would read this machine's WSL_INTEROP.
  expect(await liveInterop("", dir)).toBe(first);
  expect(await liveInterop(path.join(dir, "401_interop"), path.join(dir, "missing"))).toBeUndefined();
});
