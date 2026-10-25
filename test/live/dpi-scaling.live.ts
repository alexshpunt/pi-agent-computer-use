import sharp from "sharp";
import { afterAll, expect, test } from "vitest";
import { connectLive, nativeForm, openWindow, text, WINDOWS_POWERSHELL_PATH as POWERSHELL } from "./remote.ts";

// LPT-907: on a display scaled above 100%, Windows paints a DPI-unaware window at 96 DPI and stretches it on screen.
// Its overview must show that stretched window, so UI bounds, OCR boxes and pixel input agree with the image.
// Run it on a machine scaled above 100% (ZinPC: 150%).
const live = await connectLive();
const pids: number[] = [];
afterAll(async () => { for (const pid of pids) await live.kill(pid); await live.close(); });

type Box = { x: number; y: number; width: number; height: number };
type Element = { role?: string | null; name?: string | null; bounds?: { window_image?: Box } };
const box = (elements: Element[], match: (e: Element) => boolean): Box => {
  const found = elements.find(match)?.bounds?.window_image;
  if (!found) throw new Error(`No overview bounds in ${JSON.stringify(elements.map(e => [e.role, e.name]))}`);
  return found;
};
const centre = (b: Box) => ({ x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) });

for (const dpiAware of [false, true]) test(`a DPI-${dpiAware ? "aware" : "unaware"} window's overview, UI bounds, OCR and pixel clicks agree`, async () => {
  const title = `DPI ${dpiAware ? "aware" : "unaware"} ${Date.now()}`;
  const window = await openWindow(live, live.machine, POWERSHELL, nativeForm(title, { dpiAware }), title);
  pids.push((JSON.parse(JSON.stringify((await live.search(live.windows, title)).details.state)).windows as { pid: number }[])[0].pid);
  const view = await live.read(window, ['capture:{"maxLongEdge":3840}', "full"]);
  const elements = view.details.ui!.elements as Element[];
  const button = box(elements, e => e.role === "Button" && e.name === "Count 0");
  const field = box(elements, e => e.role === "Edit" && e.name === "Field");

  // The text box is drawn where its UI bounds say: white across the middle of its box. A DPI-unaware window used
  // to be painted at 2/3 size in the image's top-left corner, so there the box showed the form's grey or black.
  const image = view.content.find(block => block.type === "image")!;
  const { data, info } = await sharp(Buffer.from(image.data, "base64")).greyscale().raw().toBuffer({ resolveWithObject: true });
  const row = Math.round(field.y + field.height / 2);
  const inside = [0.1, 0.3, 0.5, 0.7, 0.9].map(f => data[row * info.width + Math.round(field.x + field.width * f)]);
  console.log(title, { image: [info.width, info.height], button, field, inside });
  expect(Math.min(...inside), `text box row ${row}: ${inside}`).toBeGreaterThan(245);

  // OCR finds the button's caption inside the button's UI bounds. Its line can pick up the button's edge as "|",
  // and the stretched "0" can read as "O", so the word "Count" is compared.
  const ocr = await live.read(`computer:observation/${view.details.observation_id}`, ["ocr"]);
  const caption = ocr.details.text_lines!.flatMap(line => line.words).find(word => word.text === "Count");
  expect(caption, JSON.stringify(ocr.details.text_lines)).toBeTruthy();
  const at = centre(caption!);
  expect(at.x).toBeGreaterThan(button.x); expect(at.x).toBeLessThan(button.x + button.width);
  expect(at.y).toBeGreaterThan(button.y); expect(at.y).toBeLessThan(button.y + button.height);

  // A pixel click at the button's centre in the overview presses the button.
  const click = await live.insert(`computer:observation/${view.details.observation_id}`, { action: "click", ...centre(button), successor: false });
  expect(click.details.status, text(click)).toBe("delivered");
  const after = await live.read(window, ["ui"]);
  expect((after.details.ui!.elements as Element[]).some(e => e.role === "Button" && e.name === "Count 1"), text(after)).toBe(true);
});
