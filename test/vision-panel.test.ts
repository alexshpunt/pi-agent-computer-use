import { createContext, runInContext } from "node:vm";
import { expect, test } from "vitest";
import { visionScript } from "../src/vision-panel.ts";
import { createPanelDom } from "./fixtures/vision-panel-dom.ts";

function fixture() {
  const { document } = createPanelDom();
  const context = createContext({ document, fetch: () => new Promise(() => {}), setTimeout: () => {} });
  runInContext(visionScript, context);
  return {
    frames: document.getElementById("frames"),
    render(frames: object[], revision = 1) {
      context.state = { sessionId: "test", revision, frames, requests: [], actions: [], captures: [], limitations: [] };
      runInContext("render(state)", context);
    },
  };
}
const frame = (id: string, hash = "sent") => ({ id, hash, originalHash: "raw", original: "available", stage: "prepared", time: "now", bytes: 10, width: 20, height: 20, requestId: "request-1" });

test("temporal dropdown shows every boundary frame in payload order and selects exact bytes", () => {
  const { document } = createPanelDom();
  const context = createContext({ document, fetch: () => new Promise(() => {}), setTimeout: () => {} });
  runInContext(visionScript, context);
  context.state = { sessionId: "test", revision: 1, frames: [], actions: [], captures: [], limitations: [], requests: [{ id: "r", texts: [],
    sequenceImages: [0, 1, 2, 3].map(index => ({ hash: `frame-${index}`, available: true, path: `payload[${index}]`,
      matches: [{ sequence_id: "seq", index, timestamp_ms: index * 100 }] })) }] };
  runInContext("render(state)", context);
  const section = document.getElementById("sequence-images"); const select = section.querySelector("select")!;
  expect(select.children).toHaveLength(4); expect(select.children[3].textContent).toContain("frame 3 @ 300.0 ms");
  select.value = "3"; select.handlers.change();
  expect(section.querySelector("img")!.src).toBe("images/frame-3");
  expect(section.querySelector("pre")!.textContent).toContain("payload[3]");
});

test("trace updates preserve the comparison node and selected raw image while metadata updates", () => {
  const f = fixture(); f.render([frame("one")]);
  const card = f.frames.children[0], select = card.querySelector("select")!, image = card.querySelector("img")!;
  select.value = "raw"; select.handlers.change();
  f.render([{ ...frame("two"), requestId: "request-2" }], 2);
  expect(f.frames.children[0]).toBe(card); expect(card.querySelector("select")).toBe(select);
  expect(image.src).toBe("images/raw"); expect(select.value).toBe("raw");
  expect(select.attributes["aria-label"]).toBe("Image comparison two");
  expect(card.querySelectorAll("p")[1].textContent).toContain("request-2");
});

test("identical image cards remain distinct and only replaced images lose their controls", () => {
  const f = fixture(); f.render([frame("one"), frame("two"), frame("three")]);
  const cards = [...f.frames.children]; expect(new Set(cards).size).toBe(3);
  f.render([frame("four"), frame("five"), frame("six")], 2);
  expect(f.frames.children).toEqual(cards);
  f.render([frame("seven", "different")], 3);
  expect(f.frames.children).toHaveLength(1); expect(cards.every(card => card.parent === null)).toBe(true);
  expect(f.frames.children[0].querySelector("img")!.src).toBe("images/different");
});
