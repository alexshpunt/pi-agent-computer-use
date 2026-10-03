import { spawn } from "node:child_process";
import { expect, test } from "vitest";
import { BrowserClient } from "../src/browser-client.ts";
import { cleanupBrowserProfile } from "../src/browser-profile.ts";

test("close queued during worker startup waits for the opened browser and releases its pipe", async () => {
  let release!: () => void;
  const started = new Promise<void>(resolve => { release = resolve; });
  const client = new BrowserClient(async () => {
    await started;
    return spawn(process.execPath, ["-e", `
      let data = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", chunk => {
        data += chunk;
        let end;
        while ((end=data.indexOf("\\n"))>=0) {
          const r=JSON.parse(data.slice(0,end));data=data.slice(end+1);
          process.stdout.write(JSON.stringify({id:r.id,result:{content:[{type:"text",text:r.operation}],details:{status:r.operation==="close"?"closed":"observed"}}})+"\\n");
        }
      });
    `], {stdio:["pipe","pipe","pipe"]});
  });
  const open = client.call("open", {url:"https://example.test"});
  await Promise.resolve();
  const close = client.close();
  release();
  expect((await open).details.status).toBe("observed");
  expect((await close).content).toContainEqual({type:"text",text:"close"});
  expect((await client.close()).details.status).toBe("closed");
});

test("aborted in-flight input is unknown, ends the owned pipe and cannot be replayed", async () => {
  let dispatch!: () => void;
  const dispatched = new Promise<void>(resolve=>{dispatch=resolve;});
  const client = new BrowserClient(async () => {
    const child=spawn(process.execPath, ["-e", 'process.stdin.on("data",()=>process.stderr.write("dispatched"));'],{stdio:["pipe","pipe","pipe"]});
    child.stderr.once("data", dispatch);
    return child;
  });
  const controller=new AbortController();
  const action=client.call("act",{click:"a"},controller.signal);
  await dispatched;
  controller.abort();
  expect((await action).details.status).toBe("unknown");
  await client.close();
});

test("a disconnected worker with an uncleaned lease blocks new launch and never claims cleanup succeeded", async () => {
  let launches = 0;
  const client = new BrowserClient(async () => {
    launches++;
    return spawn(process.execPath, ["-e", `
      process.stdin.once("data", () => {
        process.stdout.write(JSON.stringify({event:"profile-created",profile:"C:\\\\personal-profile"})+"\\n", () => process.exit(0));
      });
    `], {stdio:["pipe","pipe","pipe"]});
  });
  expect((await client.call("open", {url:"https://example.test"})).details.status).toBe("unknown");
  expect((await client.close()).details.status).toBe("unknown");
  expect((await client.call("open", {url:"https://example.test"})).details.status).toBe("refused");
  expect((await client.close()).details.status).toBe("unknown");
  expect(launches).toBe(1);
});

test("short hints are never reused after an owned worker is replaced", async () => {
  const client = new BrowserClient(async () => spawn(process.execPath,
    ["test/fixtures/browser-worker.ts", "/dev/null"], { stdio: ["pipe", "pipe", "pipe"] }));
  try {
    const first = await client.call("open", { url: "https://example.test" });
    const old = (first.details.elements as { hint: string }[])[0].hint;
    await client.close();
    const second = await client.call("open", { url: "https://example.test" });
    expect((second.details.elements as { hint: string }[]).map(e => e.hint)).not.toContain(old);
    expect((await client.call("act", { click: old })).details.status).toBe("refused");
  } finally { await client.close(); }
});

test("profile cleanup refuses personal paths and malformed leases before filesystem or process access", async () => {
  for (const profile of ["C:\\Users\\name\\Chrome\\Default", "/tmp/pi-visible-browser-a",
    "C:\\Temp\\.tmp\\pi-visible-browser-a\\..", "C:\\Temp\\pi-visible-browser-a"]) {
    await expect(cleanupBrowserProfile(profile)).rejects.toThrow("exact owned disposable");
  }
});
