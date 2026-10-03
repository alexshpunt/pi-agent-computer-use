import type { BrowserType } from "playwright-core";

/** Launch only an owned visible profile over a private pipe, retaining normal browser security. */
export function browserLaunchOptions(executablePath: string, profile: string): Parameters<BrowserType["launchPersistentContext"]>[1] & { args: string[] } {
  return {
    executablePath, headless: false, chromiumSandbox: true, ignoreDefaultArgs: true,
    acceptDownloads: false, viewport: null, timeout: 30_000,
    // Playwright's stock flags disable phishing checks, storage partitioning and IPC flood protection.
    // Use only the flags needed for an owned pipe/profile and predictable first launch.
    args: [
      "--user-data-dir=" + profile, "--remote-debugging-pipe",
      "--no-first-run", "--no-default-browser-check", "--disable-sync",
      "--window-size=1100,800", "about:blank",
    ],
  };
}
