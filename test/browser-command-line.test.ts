import { expect, test } from "vitest";
import { parseBrowserCommandLine } from "../src/browser-command-line.ts";
import { windowsArgument } from "../src/machine-host.ts";

test("a custom profile is read from Chrome and Edge command lines", () => {
  expect(parseBrowserCommandLine(`"C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" --user-data-dir=C:\\Temp\\p --remote-debugging-port=0 --no-first-run`))
    .toMatchObject({ channel: "msedge", userDataDir: "C:\\Temp\\p" });
  expect(parseBrowserCommandLine(`"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" "--user-data-dir=C:\\My Profile"`))
    .toMatchObject({ channel: "chrome", userDataDir: "C:\\My Profile" });
});

test("the user's ordinary browser has its default profile", () => {
  expect(parseBrowserCommandLine(`"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --profile-directory=Default`))
    .toEqual({ channel: "chrome", executable: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", userDataDir: undefined, profileDirectory: "Default" });
});

test("Windows arguments survive quoting for apps started with an environment", () => {
  expect(["plain", "", "two words", 'say "hi"', "C:\\dir with space\\", 'tail\\"quote'].map(windowsArgument))
    .toEqual(["plain", '""', '"two words"', '"say \\"hi\\""', '"C:\\dir with space\\\\"', '"tail\\\\\\"quote"']);
});

test("other programs are not Chrome or Edge", () => {
  expect(parseBrowserCommandLine(`"C:\\Windows\\System32\\notepad.exe" a.txt`)).toBeUndefined();
  expect(parseBrowserCommandLine(`"C:\\Program Files\\Mozilla Firefox\\firefox.exe"`)).toBeUndefined();
});
