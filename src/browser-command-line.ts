/** How long an extension attach waits for the connection to be approved in the browser. */
export const ATTACH_APPROVAL_MS = 120_000;

/** What a running Chrome or Edge command line reveals for the toggle and Playwright Extension routes. */
export interface BrowserProcess {
  /** Playwright channel of the executable. */
  channel: "chrome" | "msedge";
  executable: string;
  /** A non-default user data directory, when the browser was started with one. */
  userDataDir?: string;
  profileDirectory?: string;
}

const CHANNELS: Record<string, BrowserProcess["channel"]> = { "chrome.exe": "chrome", "msedge.exe": "msedge" };

/** Parse a Windows browser command line. Returns undefined for anything that is not Chrome or Edge. */
export function parseBrowserCommandLine(commandLine: string): BrowserProcess | undefined {
  const tokens = [...commandLine.matchAll(/"([^"]*)"|(\S+)/g)].map(match => match[1] ?? match[2]);
  const executable = tokens[0];
  const channel = executable ? CHANNELS[executable.split("\\").at(-1)!.toLowerCase()] : undefined;
  if (!channel) return undefined;
  const flag = (name: string) => {
    const prefix = `--${name}=`;
    const token = tokens.find(item => item.startsWith(prefix));
    return token?.slice(prefix.length).replace(/^"(.*)"$/, "$1");
  };
  return { channel, executable, userDataDir: flag("user-data-dir"), profileDirectory: flag("profile-directory") };
}
