import { expect, test } from "vitest";
import { createPersistentWgcSite } from "./fixtures/persistent-wgc-site.ts";

test("WGC fixture keeps bounded independent pointer/click witnesses and revision acknowledgements", async () => {
  const site = await createPersistentWgcSite();
  const post = (route: string, value: unknown) => fetch(site.url + route, { method:"POST", body:JSON.stringify(value) });
  try {
    expect((await post("event",{type:"pointerdown",target:"foreign",x:30,y:40,count:0})).status).toBe(400);
    expect((await post("event",{type:"pointerdown",target:"save",x:30,y:40,count:0})).status).toBe(204);
    expect((await post("event",{type:"click",target:"save",x:30,y:40,count:1})).status).toBe(204);
    expect(site.events().map(e => [e.type,e.count])).toEqual([["pointerdown",0],["click",1]]);
    const copy = site.events(); copy.splice(0);
    expect(site.events()).toHaveLength(2);
    for (let n=0;n<14;n++) expect((await post("event",{type:"pointerdown",target:"save",x:30,y:40,count:1})).status).toBe(204);
    expect((await post("event",{type:"click",target:"save",x:30,y:40,count:2})).status).toBe(400);
    const revision = site.advance();
    const draw = site.waitForDraw(revision,1000);
    expect((await post("draw",{revision})).status).toBe(204);
    expect(await draw).toBeGreaterThan(0);
    expect(site.state().acknowledged).toBe(false);
    expect((await post("paint",{revision})).status).toBe(204);
    expect(site.state().acknowledged).toBe(true);
  } finally { await site.close(); }
});
