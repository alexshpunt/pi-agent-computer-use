import { afterAll, expect, test } from "vitest";
import { windowCommand } from "../../src/computer-tools.ts";
import { presentComputerResult } from "../../src/provider.ts";
import { connectLive, nativeForm, openWindow, WINDOWS_POWERSHELL_PATH } from "./remote.ts";

// LPT-966: computer_window focus brings a window to the front while another app holds the foreground, as a click on it
// would. Before, Windows refused it whenever another process was in front (a terminal, say) and focus came back unknown.
const live = await connectLive();
afterAll(async () => { await live.close(); });

test("focus moves the foreground between two windows of other apps", async () => {
  const stamp = Date.now();
  const a = await openWindow(live, live.machine, WINDOWS_POWERSHELL_PATH, nativeForm(`pi-focus-a-${stamp}`), `regex:^pi-focus-a-${stamp}$`);
  const b = await openWindow(live, live.machine, WINDOWS_POWERSHELL_PATH, nativeForm(`pi-focus-b-${stamp}`), `regex:^pi-focus-b-${stamp}$`);
  const foreground = async () => (await live.powershell(`Add-Type -Name F -Namespace PiFocus -MemberDefinition '[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern int GetWindowText(System.IntPtr h, System.Text.StringBuilder s, int n);'; $s = New-Object System.Text.StringBuilder 256; [void][PiFocus.F]::GetWindowText([PiFocus.F]::GetForegroundWindow(), $s, 256); $s.ToString()`)).trim();
  try {
    await new Promise(resolve => setTimeout(resolve, 1500));
    for (const [window, title] of [[a, `pi-focus-a-${stamp}`], [b, `pi-focus-b-${stamp}`], [a, `pi-focus-a-${stamp}`]] as const) {
      const result = await live.resources.manageWindow(live.resources.address(window), live.cwd, windowCommand({ window, action: "focus" }));
      expect(result.details.status, presentComputerResult(result)).toBe("delivered");
      expect(await foreground()).toBe(title);
    }
  } finally {
    // Force-close refuses windows the session found by title rather than opened; both processes are this check's own.
    for (const window of [a, b]) {
      const { pid } = (await live.read(window, ["state"])).details.target as { pid: number };
      await live.kill(pid);
    }
  }
});
