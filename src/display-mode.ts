import { powershellOf, type CommandRunner } from "./runner.ts";

/** A display resolution in physical pixels. */
export interface DisplayMode { width: number; height: number }
/** A mode change on one GDI display device, with the mode it replaced. */
export interface DisplayModeChange { device: string; previous: DisplayMode; current: DisplayMode }

/**
 * Change a Windows display's resolution through the runner's own Windows (this host or a machine over SSH).
 * Changes are dynamic: Windows does not save them, so a sign-out or restart also returns the saved mode.
 * CUA has no display-mode tool; this does no capture or input.
 */
export interface DisplayModes {
  /** Switch the monitor with this native HMONITOR to a mode the driver lists, keeping colour depth and preferring the current refresh rate. */
  set(monitor: string, mode: DisplayMode, signal?: AbortSignal): Promise<DisplayModeChange>;
  /** Return a device to an earlier mode. */
  restore(device: string, mode: DisplayMode, signal?: AbortSignal): Promise<void>;
}

const SCRIPT = String.raw`
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class PiDisplay {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct DEVMODE {
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmDeviceName;
    public short dmSpecVersion, dmDriverVersion, dmSize, dmDriverExtra; public int dmFields;
    public int dmPositionX, dmPositionY, dmDisplayOrientation, dmDisplayFixedOutput;
    public short dmColor, dmDuplex, dmYResolution, dmTTOption, dmCollate;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmFormName;
    public short dmLogPixels; public int dmBitsPerPel, dmPelsWidth, dmPelsHeight, dmDisplayFlags, dmDisplayFrequency;
    public int dmICMMethod, dmICMIntent, dmMediaType, dmDitherType, dmReserved1, dmReserved2, dmPanningWidth, dmPanningHeight;
  }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct MONITORINFOEX { public int cbSize; public int l, t, r, b, wl, wt, wr, wb; public int dwFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string szDevice; }
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFOEX info);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool EnumDisplaySettings(string device, int mode, ref DEVMODE dm);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int ChangeDisplaySettingsEx(string device, ref DEVMODE dm, IntPtr hwnd, int flags, IntPtr param);
  public static DEVMODE Blank() { var dm = new DEVMODE(); dm.dmSize = (short)Marshal.SizeOf(typeof(DEVMODE)); return dm; }
}
"@
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
$device = $request.device
if ($request.monitor) {
  $info = New-Object PiDisplay+MONITORINFOEX; $info.cbSize = [Runtime.InteropServices.Marshal]::SizeOf($info)
  if (-not [PiDisplay]::GetMonitorInfo([IntPtr][Int64]$request.monitor, [ref]$info)) { throw "The monitor is gone. Read the displays again." }
  $device = $info.szDevice
}
$current = [PiDisplay]::Blank()
if (-not [PiDisplay]::EnumDisplaySettings($device, -1, [ref]$current)) { throw "Cannot read the current mode of $device." }
$best = $null; $i = 0; $mode = [PiDisplay]::Blank()
while ([PiDisplay]::EnumDisplaySettings($device, $i, [ref]$mode)) {
  if ($mode.dmPelsWidth -eq $request.width -and $mode.dmPelsHeight -eq $request.height -and $mode.dmBitsPerPel -eq $current.dmBitsPerPel -and
      ($best -eq $null -or $mode.dmDisplayFrequency -eq $current.dmDisplayFrequency -or
       ($best.dmDisplayFrequency -ne $current.dmDisplayFrequency -and $mode.dmDisplayFrequency -gt $best.dmDisplayFrequency))) { $best = $mode }
  $i++; $mode = [PiDisplay]::Blank()
}
if ($best -eq $null) {
  $sizes = @{}; $i = 0; $mode = [PiDisplay]::Blank()
  while ([PiDisplay]::EnumDisplaySettings($device, $i, [ref]$mode)) { if ($mode.dmBitsPerPel -eq $current.dmBitsPerPel) { $sizes["$($mode.dmPelsWidth)x$($mode.dmPelsHeight)"] = 1 }; $i++; $mode = [PiDisplay]::Blank() }
  throw "$device has no $($request.width)x$($request.height) mode. Supported: $(($sizes.Keys | Sort-Object { [int]($_ -split 'x')[0] }, { [int]($_ -split 'x')[1] }) -join ', ')."
}
$best.dmFields = 0x5C0000
$status = [PiDisplay]::ChangeDisplaySettingsEx($device, [ref]$best, [IntPtr]::Zero, 0, [IntPtr]::Zero)
if ($status -ne 0) { throw "Windows refused the mode change (code $status)." }
@{ device = $device; previous = @{ width = $current.dmPelsWidth; height = $current.dmPelsHeight }; current = @{ width = $best.dmPelsWidth; height = $best.dmPelsHeight } } | ConvertTo-Json -Compress
`;

/** Display modes changed through Windows PowerShell started by the runner. */
export function displayModes(runner: CommandRunner): DisplayModes {
  const change = async (request: Record<string, unknown>, signal?: AbortSignal): Promise<DisplayModeChange> => {
    const output = await runner.run(powershellOf(runner), ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand",
      Buffer.from(`$ProgressPreference = 'SilentlyContinue'; $ErrorActionPreference = 'Stop'\ntry {\n${SCRIPT}\n} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }`, "utf16le").toString("base64")],
      { input: JSON.stringify(request), signal, timeoutMs: 30_000 });
    return JSON.parse(output.trim()) as DisplayModeChange;
  };
  return {
    set: (monitor, mode, signal) => change({ monitor, ...mode }, signal),
    restore: async (device, mode, signal) => { await change({ device, ...mode }, signal); },
  };
}

/** Accept only whole positive pixel sizes a display could have. */
export function displayMode(value: Record<string, unknown>): DisplayMode {
  const { width, height } = value;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || (width as number) < 640 || (height as number) < 480 || (width as number) > 16384 || (height as number) > 16384)
    throw new Error("Resize needs integer width and height in physical pixels, at least 640x480.");
  return { width: width as number, height: height as number };
}
