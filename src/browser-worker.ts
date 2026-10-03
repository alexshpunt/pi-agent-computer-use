import { serveBrowserWorker } from "./browser-protocol.ts";
import { PlaywrightBrowser } from "./browser-playwright.ts";

serveBrowserWorker(new PlaywrightBrowser(profile => {
  process.stdout.write(JSON.stringify({ event: "profile-created", profile }) + "\n");
}));
