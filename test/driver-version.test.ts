import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import { McpDriver } from "../src/driver.ts";

test("the qualified pin rejects an older peer before native dispatch", async () => {
  await mkdir(".tmp/native-zoom", {recursive:true});
  const cwd = await mkdtemp(path.resolve(".tmp/native-zoom/version-")); const log = path.join(cwd,"calls.jsonl");
  const backend = new McpDriver({command:process.execPath,args:[path.resolve("test/fixtures/detail-driver.mjs"),log,"0.33.1"]});
  try {
    await expect(backend.call("get_desktop_state",{max_image_dimension:500})).rejects.toThrow("requires cua-driver 0.33.2");
    expect(await readFile(log,"utf8").catch(()=>"")).toBe("");
  } finally { await backend.close(); await rm(cwd,{recursive:true,force:true}); }
});
