<#
.SYNOPSIS
  Starts, stops and inspects the DSH Web host with the phone surface.

.DESCRIPTION
  The phone is a client of the same Host the PC uses, so "syncing" is not a
  copy step: one Host owns the session store and both clients read and write
  it live. This script boots that Host with the mobile plugin mounted and the
  listener bound to the LAN, then prints the pairing card (PIN and QR) the
  phone needs.

.PARAMETER Action
  start (default), stop, status, restart.

.PARAMETER Port
  The port the host listens on. 0 lets the OS pick one.

.PARAMETER Bind
  The address the host binds. Use 127.0.0.1 to keep the host off the network.

.PARAMETER Profile
  The DSH profile to boot. The plugin has to be part of it.

.EXAMPLE
  .\dsh-mobile.ps1 start
  .\dsh-mobile.ps1 status
  .\dsh-mobile.ps1 stop
#>
[CmdletBinding()]
param(
	[ValidateSet('start', 'stop', 'status', 'restart')]
	[string]$Action = 'start',
	[ValidateRange(0, 65535)]
	[int]$Port = 3080,
	[string]$Bind = '0.0.0.0',
	[string]$Profile = 'web'
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Patch = Join-Path $Root 'lan.patch.yml'
$Log = Join-Path $Root 'host.log'
$PairFile = Join-Path ($env:DSH_HOME ?? (Join-Path $env:USERPROFILE '.dsh')) 'mobile-pair.json'

function Get-HostProcess {
	$connection = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue |
		Where-Object { $_.LocalAddress -eq $Bind -or $Bind -eq '0.0.0.0' } |
		Select-Object -First 1
	if ($null -eq $connection) { return $null }
	return Get-Process -Id $connection.OwningProcess -ErrorAction SilentlyContinue
}

function Show-PairingCard {
	if (-not (Test-Path $PairFile)) {
		Write-Host "dsh-mobile: ペアリングカードがまだありません ($PairFile)" -ForegroundColor Yellow
		return
	}
	& node (Join-Path $Root 'tools\show-pair.mjs') $PairFile
}

switch ($Action) {
	'start' {
		if ($null -ne (Get-HostProcess)) {
			Write-Host "dsh-mobile: 既にポート $Port でホストが起動しています" -ForegroundColor Yellow
			Show-PairingCard
			break
		}
		$env:DSH_MOBILE_BIND = $Bind
		$env:DSH_MOBILE_PORT = "$Port"
		Write-Host "dsh-mobile: ホストを起動します (bind=$Bind port=$Port profile=$Profile)" -ForegroundColor Cyan
		# `dsh` is installed as a PowerShell script on Windows, so it is run
		# through pwsh rather than executed directly.
		$command = Get-Command dsh -ErrorAction SilentlyContinue
		if ($null -eq $command) { throw "dsh-mobile: `dsh` が見つかりません" }
		$arguments = @('-NoProfile', '-File', $command.Source, '--profile', $Profile, '--patch', $Patch, '--no-open')
		$process = Start-Process -FilePath 'pwsh' `
			-ArgumentList $arguments `
			-WorkingDirectory $Root -WindowStyle Hidden -PassThru `
			-RedirectStandardOutput $Log -RedirectStandardError "$Log.err"
		Start-Sleep -Seconds 2
		# The Host needs a while to boot, and the pairing card is only written
		# once the listener is up: wait for the port before reading it.
		$ready = $false
		for ($attempt = 0; $attempt -lt 90; $attempt++) {
			if ($process.HasExited) { break }
			$listener = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue
			if ($null -ne $listener) { $ready = $true; break }
			Start-Sleep -Seconds 1
		}
		if (-not $ready) {
			Write-Host "dsh-mobile: 起動を確認できませんでした。ログを確認してください: $Log" -ForegroundColor Red
			Get-Content $Log -Tail 30 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "  $_" }
			exit 1
		}
		Show-PairingCard
	}
	'stop' {
		$process = Get-HostProcess
		if ($null -eq $process) {
			Write-Host "dsh-mobile: ポート $Port でホストは起動していません" -ForegroundColor Yellow
			break
		}
		Stop-Process -Id $process.Id -Force
		Write-Host "dsh-mobile: ホストを停止しました (pid $($process.Id))" -ForegroundColor Cyan
	}
	'status' {
		$process = Get-HostProcess
		if ($null -eq $process) {
			Write-Host "dsh-mobile: ポート $Port でホストは起動していません" -ForegroundColor Yellow
			break
		}
		Write-Host "dsh-mobile: ホストは起動中です (pid $($process.Id), bind=$Bind, port=$Port)" -ForegroundColor Green
		Show-PairingCard
	}
	'restart' {
		& $MyInvocation.MyCommand.Path stop
		Start-Sleep -Seconds 2
		& $MyInvocation.MyCommand.Path start
	}
}
