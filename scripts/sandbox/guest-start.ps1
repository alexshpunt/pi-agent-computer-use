# Runs in the Windows Sandbox guest user session: start the CUA driver with its loopback HTTP MCP endpoint and the
# window identity bridge. Both are detached, so `wsb exec` returns at once.
$env:CUA_DRIVER_RS_MCP_HTTP_PORT = '47801'
$env:CUA_DRIVER_RS_MCP_HTTP_TOKEN = (Get-Content 'C:\pi\config\token.txt' -Raw).Trim()
$env:CUA_DRIVER_RS_TELEMETRY_ENABLED = 'false'
$env:CUA_DRIVER_RS_UPDATE_CHECK = 'false'
$env:DO_NOT_TRACK = '1'
# Foreground input pauses until 10 s pass without the human's keyboard or mouse input (LPT-835).
$env:CUA_HUMAN_IDLE_MS = '10000'
$env:CUA_DRIVER_ALLOW_DEBUGGING_LAUNCH = '1'
Start-Process -FilePath 'C:\pi\runtime\cua-driver.exe' -ArgumentList 'serve' -WindowStyle Hidden `
  -RedirectStandardOutput 'C:\pi\out\driver.out' -RedirectStandardError 'C:\pi\out\driver.err'
Start-Process powershell.exe -WindowStyle Hidden -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File C:\pi\config\guest-identity-bridge.ps1'
