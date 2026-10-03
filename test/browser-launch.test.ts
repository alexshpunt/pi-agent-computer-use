import { expect, test } from "vitest";
import { browserLaunchOptions } from "../src/browser-launch.ts";

test("visible browser uses its supplied owned profile and private pipe without weaker security flags", () => {
  const profile = "C:\\Temp\\.tmp\\pi-browser-owned";
  const options = browserLaunchOptions("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", profile);
  expect(options).toMatchObject({ headless: false, chromiumSandbox: true, ignoreDefaultArgs: true, acceptDownloads: false });
  expect(options.args).toContain("--user-data-dir=" + profile);
  expect(options.args).toContain("--remote-debugging-pipe");
  expect(options.args).toContain("about:blank");
  expect(options.args.some(arg => /no-sandbox|disable-web-security|remote-debugging-port|ignore-certificate-errors|disable.*phishing|disable.*isolation/i.test(arg))).toBe(false);
  expect(options.executablePath).toContain("chrome.exe");
});
