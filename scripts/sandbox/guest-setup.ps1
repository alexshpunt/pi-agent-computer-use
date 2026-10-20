# Runs in a Windows Sandbox guest as SYSTEM: expose the driver's loopback HTTP endpoint and the identity bridge
# to the host. Only the host relay connects to these ports.

# A fresh guest can enforce Smart App Control, which blocks the unsigned driver ("blocked by your organization's
# Device Guard policy"). Turn it off in this disposable guest only and refresh the policies; the host is unchanged.
Set-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\CI\Policy' -Name VerifiedAndReputablePolicyState -Value 0 -Type DWord
CiTool.exe --refresh --json | Out-Null
netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=47800 connectaddress=127.0.0.1 connectport=47801 | Out-Null
New-NetFirewallRule -DisplayName 'Pi computer use: driver' -Direction Inbound -Protocol TCP -LocalPort 47800 -Action Allow | Out-Null
New-NetFirewallRule -DisplayName 'Pi computer use: window identity' -Direction Inbound -Protocol TCP -LocalPort 47802 -Action Allow | Out-Null
