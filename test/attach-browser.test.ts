import { expect, test, vi } from "vitest";
import { ComputerSession, type ComputerMode, type Driver, type DriverResult } from "../src/session.ts";
import type { WebBrowser, WebLauncher } from "../src/web-browser.ts";

// LPT-850: Playwright attaches to a running Chrome or Edge only in YOLO, binds it to the addressed window, and the
// session's close detaches through the worker instead of leaving the browser to anyone else.
const window = { pid: 4100, window_id: 77, title: "Attach target - Personal - Microsoft Edge", app_name: "msedge.exe", bounds: { x: 0, y: 0, width: 800, height: 600 } };

function fixture() {
  let mode: ComputerMode = "yolo";
  const call = vi.fn<Driver["call"]>(async (name): Promise<DriverResult> => {
    if (name === "list_windows") return { content: [], structuredContent: { windows: [window] } };
    throw new Error(`Unexpected native call ${name}`);
  });
  const browser = { close: vi.fn(async () => {}), page: vi.fn(async () => ({ url: "data:", title: "Attach target", snapshot: "- textbox \"Field\"", tabs: [], events: [] })) };
  const launch = vi.fn<WebLauncher>(async () => ({ browser: browser as unknown as WebBrowser,
    opened: { pid: window.pid, version: "155", url: "data:", title: "Attach target", via: "cdp" } }));
  const session = new ComputerSession({ call, identity: vi.fn(async () => "life"), close: vi.fn(async () => {}) }, () => mode, undefined, undefined, launch);
  const ref = async () => ((await session.windows()).details.state!.windows as { window_ref: string }[])[0].window_ref;
  return { session, launch, browser, ref, setMode(value: ComputerMode) { mode = value; } };
}

test("Safe mode refuses before any Playwright work", async () => {
  const f = fixture();
  const ref = await f.ref();
  f.setMode("safe");
  const result = await f.session.attachBrowser(ref);
  expect(result.details.status).toBe("refused");
  expect(f.launch).not.toHaveBeenCalled();
});

test("an attached window serves DOM reads, refuses a second attach, and the session close detaches", async () => {
  const f = fixture();
  const ref = await f.ref();
  expect((await f.session.observeDom(ref)).details.status).toBe("refused");
  const attached = await f.session.attachBrowser(ref);
  expect(attached.details.status).toBe("delivered");
  // The worker receives the window's own process and title, which pick the visible tab.
  expect(f.launch).toHaveBeenCalledWith({ attach: { pid: window.pid, title: window.title } }, undefined);
  expect((await f.session.observeDom(ref)).details.status).toBe("observed");
  expect((await f.session.attachBrowser(ref)).details.status).toBe("refused");
  expect(f.launch).toHaveBeenCalledTimes(1);
  await f.session.close();
  expect(f.browser.close).toHaveBeenCalledTimes(1);
});
