# Session-owned window lifetime markers. No UI capture, input, or app launch.
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class PiWindowIdentity {
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr GetProp(IntPtr hwnd, string name);
    [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool SetProp(IntPtr hwnd, string name, IntPtr value);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr RemoveProp(IntPtr hwnd, string name);
}
'@
$key = 'PiComputerUse.' + [Guid]::NewGuid().ToString('N')
$next = 0L
$owned = @{}
try {
    while ($null -ne ($line = [Console]::ReadLine())) {
        try {
            $request = $line | ConvertFrom-Json
            $hwnd = [IntPtr]::new([long]$request.window_id)
            $owner = [uint32]0
            $thread = [PiWindowIdentity]::GetWindowThreadProcessId($hwnd, [ref]$owner)
            $identity = $null
            if ($thread -ne 0 -and $owner -eq [uint32]$request.pid) {
                $value = [PiWindowIdentity]::GetProp($hwnd, $key).ToInt64()
                if ($value -eq 0 -and $request.create) {
                    $next++
                    if ([PiWindowIdentity]::SetProp($hwnd, $key, [IntPtr]::new($next))) {
                        $value = $next
                        $owned[[long]$request.window_id] = $value
                    }
                }
                if ($value -ne 0) { $identity = $key + ':' + $owner + ':' + $value }
            }
            [Console]::WriteLine((@{ identity = $identity } | ConvertTo-Json -Compress))
        } catch {
            [Console]::WriteLine((@{ error = $_.Exception.Message } | ConvertTo-Json -Compress))
        }
    }
} finally {
    foreach ($handle in @($owned.Keys)) {
        $hwnd = [IntPtr]::new([long]$handle)
        if ([PiWindowIdentity]::GetProp($hwnd, $key).ToInt64() -eq $owned[$handle]) {
            [void][PiWindowIdentity]::RemoveProp($hwnd, $key)
        }
    }
}
