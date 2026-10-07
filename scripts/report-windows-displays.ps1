# Read-only OS comparison for selected-monitor qualification. No capture, input or persistent DPI change.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class PiMonitorReport {
    [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] public static extern IntPtr MonitorFromPoint(long point, uint flags);
    [DllImport("shcore.dll")] public static extern int GetScaleFactorForMonitor(IntPtr monitor, out int scale);
    public static double? Scale(int x, int y) {
        long point = ((long)y << 32) | (uint)x;
        IntPtr monitor = MonitorFromPoint(point, 0);
        int scale;
        return monitor != IntPtr.Zero && GetScaleFactorForMonitor(monitor, out scale) == 0 ? (double?)scale / 100 : null;
    }
}
'@
$previous = [PiMonitorReport]::SetThreadDpiAwarenessContext([IntPtr](-4))
if ($previous -eq [IntPtr]::Zero) { throw 'Could not establish scoped physical monitor coordinates' }
try {
    $displays = @([System.Windows.Forms.Screen]::AllScreens | ForEach-Object {
        $b = $_.Bounds; $w = $_.WorkingArea
        [pscustomobject]@{
            display_id = $_.DeviceName
            bounds = [pscustomobject]@{x=$b.X;y=$b.Y;width=$b.Width;height=$b.Height}
            work_area = [pscustomobject]@{x=$w.X;y=$w.Y;width=$w.Width;height=$w.Height}
            primary = $_.Primary
            scale_factor = [PiMonitorReport]::Scale($b.X + [int]($b.Width / 2), $b.Y + [int]($b.Height / 2))
            dpi = $null
        }
    })
    ConvertTo-Json -Depth 5 -InputObject $displays
} finally {
    [void][PiMonitorReport]::SetThreadDpiAwarenessContext($previous)
}
