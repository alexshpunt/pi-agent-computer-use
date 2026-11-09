import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { localRunner } from "../src/runner.ts";
import { WebBrowser } from "../src/web-browser.ts";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

test("an installed TypeScript browser worker can receive requests", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-installed-worker-"));
  temporary.push(root);
  const dir = path.join(root, "node_modules", "browser-worker");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "package.json"), '{"type":"module"}');
  const worker = path.join(dir, "worker.ts");
  await writeFile(worker, `import readline from "node:readline";
readline.createInterface({input: process.stdin}).on("line", (line: string) => {
  const request = JSON.parse(line);
  process.stdout.write(JSON.stringify({id: request.id, value: request.op === "open" ? {pid: 123} : {}}) + "\\n");
});
`);
  const local = localRunner();
  const runner = { ...local, run: async (command: string, args: string[]) => command === "wslpath" ? args[1] : local.run(command, args) };
  const { browser, opened } = await WebBrowser.launch({ remote: { runner, node: process.execPath, worker, loader: pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href } });
  expect(opened.pid).toBe(123);
  await browser.close();
}, 15_000);
