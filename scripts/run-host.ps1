<#
.SYNOPSIS
  Runs the DSH Web host in its own process and writes the logs into the repository.

.DESCRIPTION
  dsh-mobile.ps1 starts this script detached from the launching shell (through
  Explorer), so the host keeps running after the terminal that started it is
  closed. The host output is redirected here because a detached process cannot
  inherit the standard output handles of the launcher.

  The redirection goes through cmd.exe on purpose: cmd redirects the handles
  themselves, so the host writes to the log directly. A PowerShell pipeline
  would buffer the output and the log would stay empty while the host runs.

.PARAMETER Profile
  The DSH profile to boot.

.PARAMETER Patch
  The patch file that binds the host to the LAN.

.PARAMETER Log
  Where the host output is written. The error output goes to the same path
  with a .err suffix.
#>
param(
	[string] $Profile = 'web',
	[string] $Patch = 'lan.patch.yml',
	[string] $Log = 'host.log'
)

$ErrorActionPreference = 'Continue'
$port = [int]($env:DSH_MOBILE_PORT ?? 3080)
$listener = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue
if ($null -ne $listener) {
	# Another host already owns the port; there is nothing to start.
	exit 0
}
$command = Get-Command dsh -ErrorAction SilentlyContinue
if ($null -eq $command) {
	Write-Error 'dsh が見つかりません（npm install -g @deepseek-ai/dsh）。'
	exit 1
}
$inner = 'pwsh -NoProfile -NoLogo -File "{0}" --profile {1} --patch "{2}" --no-open > "{3}" 2> "{4}"' -f `
	$command.Source, $Profile, $Patch, $Log, "$Log.err"
& cmd /c $inner
exit $LASTEXITCODE
