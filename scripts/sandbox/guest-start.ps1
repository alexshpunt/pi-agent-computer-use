# Runs in the Windows Sandbox guest user session: start the CUA driver with its loopback HTTP MCP endpoint, the
# window identity bridge, the window streams and the input lease. All are detached, so `wsb exec` returns at once.
$env:CUA_DRIVER_RS_MCP_HTTP_PORT = '47801'
$env:CUA_DRIVER_RS_MCP_HTTP_TOKEN = (Get-Content 'C:\pi\config\token.txt' -Raw).Trim()
$env:CUA_DRIVER_RS_TELEMETRY_ENABLED = 'false'
$env:CUA_DRIVER_RS_UPDATE_CHECK = 'false'
$env:DO_NOT_TRACK = '1'
$env:CUA_DRIVER_ALLOW_DEBUGGING_LAUNCH = '1'
Start-Process -FilePath 'C:\pi\runtime\cua-driver.exe' -ArgumentList 'serve' -WindowStyle Hidden `
  -RedirectStandardOutput 'C:\pi\out\driver.out' -RedirectStandardError 'C:\pi\out\driver.err'
Start-Process powershell.exe -WindowStyle Hidden -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File C:\pi\config\guest-identity-bridge.ps1'
# Window streams for the session tiles: cua-spacesd captures windows and encodes H.264. Its token travels in the
# environment, never on a command line, and only this one child inherits it.
$env:CUA_ENV_TOKEN = (Get-Content 'C:\pi\config\spacesd-token.txt' -Raw).Trim()
try {
  Start-Process -FilePath 'C:\pi\runtime\cua-spacesd.exe' -WindowStyle Hidden `
    -ArgumentList 'serve', '--listen', '127.0.0.1:47805', '--quic-port', '0', '--no-mcp', '--data-dir', (Join-Path $env:LOCALAPPDATA 'pi-spacesd') `
    -RedirectStandardOutput 'C:\pi\out\spacesd.out' -RedirectStandardError 'C:\pi\out\spacesd.err'
} finally { Remove-Item Env:CUA_ENV_TOKEN }
# Agents sharing this sandbox take turns with its mouse and keyboard through this service.
Start-Process powershell.exe -WindowStyle Hidden -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File C:\pi\config\guest-lease.ps1' `
  -RedirectStandardError 'C:\pi\out\lease.err'
