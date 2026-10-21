import { expect, test } from "vitest";
import { parseBrowserCommandLine } from "../src/browser-command-line.ts";

test("a debugging port and a custom profile select CDP", () => {
  expect(parseBrowserCommandLine(`"C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" --user-data-dir=C:\\Temp\\p --remote-debugging-port=0 --no-first-run`))
    .toMatchObject({ channel: "msedge", userDataDir: "C:\\Temp\\p", debuggingPort: 0 });
  expect(parseBrowserCommandLine(`"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" "--user-data-dir=C:\\My Profile" --remote-debugging-port=9222`))
    .toMatchObject({ channel: "chrome", userDataDir: "C:\\My Profile", debuggingPort: 9222 });
});

test("the user's ordinary browser has neither", () => {
  expect(parseBrowserCommandLine(`"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --profile-directory=Default`))
    .toEqual({ channel: "chrome", executable: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", userDataDir: undefined, profileDirectory: "Default", debuggingPort: undefined });
});

test("other programs are not browsers Playwright can attach to", () => {
  expect(parseBrowserCommandLine(`"C:\\Windows\\System32\\notepad.exe" a.txt`)).toBeUndefined();
  expect(parseBrowserCommandLine(`"C:\\Program Files\\Mozilla Firefox\\firefox.exe"`)).toBeUndefined();
});
