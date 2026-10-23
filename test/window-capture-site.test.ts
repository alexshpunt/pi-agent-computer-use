import { expect, test } from "vitest";
import { createWindowCaptureSite } from "./fixtures/window-capture-site.ts";

test("drawing acknowledgement belongs to the current revision and cannot certify a future frame", async () => {
  const site = await createWindowCaptureSite();
  try {
    expect(site.state().acknowledged).toBe(false);
    expect(site.advance()).toBe(1);
    const post = (revision: number) => fetch(site.url + "paint", { method: "POST", body: JSON.stringify({ revision }) });
    expect((await post(2)).status).toBe(400);
    expect(site.state().acknowledged).toBe(false);
    expect((await post(1)).status).toBe(204);
    expect(site.state().acknowledged).toBe(true);
    const previous = site.state().color;
    site.advance();
    expect(site.state().acknowledged).toBe(false);
    expect(site.state().color).not.toEqual(previous);
    expect(await (await fetch(site.url + "state")).json()).toEqual({ revision: 2, color: site.state().color });
  } finally { await site.close(); }
});

test("witness revisions, retained input events and request bodies have finite limits", async () => {
  const site = await createWindowCaptureSite();
  try {
    for (let i = 0; i < 48; i++) site.advance();
    expect(() => site.advance()).toThrow("budget exhausted");
    for (let count = 1; count <= 16; count++) {
      expect((await fetch(site.url + "event", { method: "POST", body: JSON.stringify({ type: "click", count }) })).status).toBe(204);
    }
    expect((await fetch(site.url + "event", { method: "POST", body: JSON.stringify({ type: "click", count: 17 }) })).status).toBe(400);
    expect(site.events()).toHaveLength(16);
    const copy = site.events(); copy.length = 0;
    expect(site.events()).toHaveLength(16);
    expect((await fetch(site.url + "paint", { method: "POST", body: "x".repeat(1025) })).status).toBe(413);
  } finally { await site.close(); }
});
