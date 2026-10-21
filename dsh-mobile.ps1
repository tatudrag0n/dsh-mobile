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
	[string]$Bind = '',
	[string]$Profile = 'web'
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Patch = Join-Path $Root 'lan.patch.yml'
$Log = Join-Path $Root 'host.log'
$PairFile = Join-Path ($env:DSH_HOME ?? (Join-Path $env:USERPROFILE '.dsh')) 'mobile-pair.json'

function Get-HostProcess {
	$connections = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue |
		Where-Object { $_.OwningProcess -gt 0 })
	if ($connections.Count -eq 0) { return $null }
	# バインドしたアドレスを優先し、DHCP で IP が変わっていても拾えるようにする。
	$connection = $connections | Where-Object { $_.LocalAddress -eq $Bind } | Select-Object -First 1
	if ($null -eq $connection) { $connection = $connections[0] }
	return Get-Process -Id $connection.OwningProcess -ErrorAction SilentlyContinue
}

function Show-PairingCard {
	if (-not (Test-Path $PairFile)) {
		Write-Host "dsh-mobile: ペアリングカードがまだありません ($PairFile)" -ForegroundColor Yellow
		return
	}
	& node (Join-Path $Root 'tools\show-pair.mjs') $PairFile
}

function Get-LanAddress {
	# dsh 0.2.1 以降の webserver はワイルドカード (0.0.0.0) を拒否し、
	# ローカルの具体的な IPv4 アドレスを 1 つだけ，要求する。
	# 既定経路を持つ NIC を優先し、APIPA (169.254.x) は LAN 宛先として使わない。
	$route = Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue |
		Sort-Object RouteMetric |
		Where-Object { $_.InterfaceAlias -notmatch 'Loopback|Tailscale|WSL|VMware|VirtualBox|Hyper-V' } |
		Select-Object -First 1
	if (-not $route) { return '127.0.0.1' }
	$address = Get-NetIPAddress -InterfaceIndex $route.InterfaceIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue |
		Where-Object { $_.IPAddress -ne '127.0.0.1' -and $_.IPAddress -notlike '169.254.*' } |
		Select-Object -First 1
	if ($address) { return $address.IPAddress }
	return '127.0.0.1'
}

function Get-DesktopDshVersion {
	# デスクトップアプリが同梱する dsh のバージョン。
	# app.asar は Electron 専用だが、ヘッダの JSON だけ読むので素の Node/PowerShell で十分。
	$asar = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\app.asar"
	if (-not (Test-Path $asar)) { return $null }
	try {
		$bytes = [System.IO.File]::ReadAllBytes($asar)
		$headerSize = [BitConverter]::ToUInt32($bytes, 4)
		$jsonSize = [BitConverter]::ToUInt32($bytes, 12)
		$header = [Text.Encoding]::UTF8.GetString($bytes, 16, $jsonSize) | ConvertFrom-Json
		$entry = $header.files.dsh.files.'package.json'
		$dataStart = 8 + $headerSize
		$json = [Text.Encoding]::UTF8.GetString($bytes, $dataStart + [int]$entry.offset, $entry.size) | ConvertFrom-Json
		return $json.version
	} catch {
		return $null
	}
}

function Test-VersionParity {
	# CLI とデスクトップアプリの dsh が違うと、セッションログのイベント型が
	# 解釈できず「履歴の読み込みに失敗」になる。起動時に警告する。
	$cli = $null
	try { $cli = (& dsh --version 2>$null | Select-Object -First 1).ToString().Trim() } catch { $cli = $null }
	$desktop = Get-DesktopDshVersion
	if (-not $cli -or -not $desktop) { return }
	if ($cli -eq $desktop) { return }
	Write-Host "dsh-mobile: 警告: CLI の dsh ($cli) とデスクトップアプリの dsh ($desktop) が異なります。" -ForegroundColor Yellow
	Write-Host "             セッションログのイベント型が解釈できず「履歴の読み込みに失敗」になります。" -ForegroundColor Yellow
	Write-Host "             npm install -g @deepseek-ai/dsh@$desktop" -ForegroundColor Yellow
}

# バインドアドレスは start 以外（status/stop）でも同じ解決結果を使う。
if (-not $Bind) { $Bind = Get-LanAddress }

switch ($Action) {
	'start' {
		if ($null -ne (Get-HostProcess)) {
			Write-Host "dsh-mobile: 既にポート $Port でホストが起動しています" -ForegroundColor Yellow
			Show-PairingCard
			break
		}
		if (-not $Bind) { $Bind = Get-LanAddress }
		$env:DSH_MOBILE_BIND = $Bind

		$env:DSH_MOBILE_PORT = "$Port"
		Write-Host "dsh-mobile: ホストを起動します (bind=$Bind port=$Port profile=$Profile)" -ForegroundColor Cyan
		# `dsh` is installed as a PowerShell script on Windows, so it is run
		# through pwsh rather than executed directly.
		$command = Get-Command dsh -ErrorAction SilentlyContinue
		if ($null -eq $command) { throw "dsh-mobile: `dsh` が見つかりません" }
		Test-VersionParity
		$runner = Join-Path $Root 'scripts\run-host.ps1'
		$runnerArguments = @(
			'-NoProfile', '-WindowStyle', 'Hidden', '-File', $runner,
			'-Profile', $Profile, '-Patch', $Patch, '-Log', $Log
		)
		$process = $null
		try {
			# Explorer 経由で起動すると、起動元のシェルやセッションを閉じても
			# ホストは動き続ける（親プロセスに依存しない）。
			$shell = New-Object -ComObject Shell.Application
			$shell.ShellExecute('pwsh', ($runnerArguments -join ' '), $Root, 'open', 0) | Out-Null
		} catch {
			Write-Warning 'Explorer 経由で起動できなかったため、子プロセスとして起動します。'
			$process = Start-Process -FilePath 'pwsh' `
				-ArgumentList $runnerArguments `
				-WorkingDirectory $Root -WindowStyle Hidden -PassThru
		}
		Start-Sleep -Seconds 2
		# The Host needs a while to boot, and the pairing card is only written
		# once the listener is up: wait for the port before reading it.
		$ready = $false
		for ($attempt = 0; $attempt -lt 90; $attempt++) {
			if ($null -ne $process -and $process.HasExited) { break }
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
