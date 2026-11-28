# Runs in the SSH login session of a Windows machine (the services session, which has no desktop). Makes sure the
# session helper runs in the user's interactive session, through a one-shot scheduled task of the same user.
# Arguments: the helper's exe and the pipe name. Exit code 0 when the pipe exists; the reason is on stderr otherwise.
param([string]$Exe, [string]$Pipe)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
    [void][Reflection.Assembly]::LoadFrom($Exe)
    $path = '\\.\pipe\' + $Pipe
    if (-not [IO.File]::Exists($path)) {
        $sessions = @([PiSessionHost.Sessions]::ActiveOfCurrentUser())
        if ($sessions.Count -eq 0) { throw "No interactive Windows session of $env:USERNAME is active on this machine. Sign in on its desktop, or reconnect the disconnected Remote Desktop session, and try again." }
        if ($sessions.Count -gt 1) { throw "More than one active Windows session of $env:USERNAME ($($sessions -join ', ')) is open on this machine. Disconnect the unintended one and try again." }
        $mutex = New-Object Threading.Mutex($false, "Global\PiComputerUse.Start.$Pipe")
        try { [void]$mutex.WaitOne() } catch [Threading.AbandonedMutexException] { }
        $task = "PiComputerUse-$Pipe"
        try {
            if (-not [IO.File]::Exists($path)) {
                # An Interactive-only task of the same user starts in that user's desktop session, not the services session.
                $action = New-ScheduledTaskAction -Execute $Exe -Argument "serve $Pipe"
                $principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
                $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)
                Register-ScheduledTask -TaskName $task -Action $action -Principal $principal -Settings $settings -Force | Out-Null
                Start-ScheduledTask -TaskName $task
                for ($i = 0; $i -lt 200 -and -not [IO.File]::Exists($path); $i++) { Start-Sleep -Milliseconds 100 }
                if (-not [IO.File]::Exists($path)) { throw 'The session helper did not start in the interactive Windows session within 20 s.' }
            }
        } finally {
            # The running helper outlives its task; the task is only the way into the desktop session.
            Unregister-ScheduledTask -TaskName $task -Confirm:$false -ErrorAction SilentlyContinue
            $mutex.ReleaseMutex()
        }
    }
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 125
}
