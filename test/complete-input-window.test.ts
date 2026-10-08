import { expect, test, vi } from "vitest";
// @ts-expect-error The opt-in live script is JavaScript and is not part of the TypeScript build.
import { openCompleteInputWindow } from "../scripts/complete-input-window.mjs";

const chrome = { name: "Google Chrome", launch_path: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" };

test("disposable launch uses one executable when native app discovery lists multiple running Chrome instances", async () => {
  let launched = false;
  const call = vi.fn(async (name: string, _args: unknown) => {
    if (name === "list_apps") return { structuredContent: { apps: [{ ...chrome, pid: 10 }, { ...chrome, pid: 20 }] } };
    if (name === "list_windows") return { structuredContent: { windows: launched ? [{ pid: 30, window_id: 40 }] : [] } };
    if (name === "launch_app") { launched = true; return { structuredContent: { pid: 30 } }; }
    throw Error(`Unexpected native call ${name}`);
  });
  const fixture = await openCompleteInputWindow({ call }, "http://127.0.0.1/fixture", "C:\\PiFixture", ["--force-color-profile=srgb"]);
  expect(fixture.target).toEqual({ pid: 30, window_id: 40 });
  expect(call.mock.calls.filter(([name]) => name === "launch_app")).toHaveLength(1);
  expect(call.mock.calls.find(([name]) => name === "launch_app")?.[1]).toEqual({
    launch_path: chrome.launch_path,
    additional_arguments: [expect.stringMatching(/^--user-data-dir=C:\\PiFixture\\/), "--no-first-run", "--no-default-browser-check", "--new-window", "--force-renderer-accessibility", "--force-color-profile=srgb", "http://127.0.0.1/fixture"],
  });
});

test("different Chrome executables refuse before launching any disposable window", async () => {
  const call = vi.fn(async () => ({ structuredContent: { apps: [chrome, { ...chrome, launch_path: "C:\\Other\\chrome.exe" }] } }));
  await expect(openCompleteInputWindow({ call }, "http://127.0.0.1/fixture", "C:\\PiFixture")).rejects.toThrow("one exact installed Google Chrome");
  expect(call).toHaveBeenCalledTimes(1);
});
