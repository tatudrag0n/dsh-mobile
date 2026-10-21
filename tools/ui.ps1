# Helper for driving the emulator UI: find a node by text, then tap or type.
# Usage:
#   pwsh -NoProfile -File tools/ui.ps1 dump
#   pwsh -NoProfile -File tools/ui.ps1 tap "接続する"
#   pwsh -NoProfile -File tools/ui.ps1 type "180585"
param(
	[Parameter(Mandatory = $true)][string]$Action,
	[string]$Value = ''
)

$ErrorActionPreference = 'Stop'
$adb = "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe"

function Get-Ui {
	& $adb shell uiautomator dump /sdcard/ui.xml | Out-Null
	return (& $adb shell cat /sdcard/ui.xml | Out-String)
}

function Get-Bounds {
	param([string]$Xml, [string]$Needle)
	$pattern = '<node[^>]*text="' + [regex]::Escape($Needle) + '"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"'
	$match = [regex]::Match($Xml, $pattern)
	if (-not $match.Success) { return $null }
	$x1 = [int]$match.Groups[1].Value; $y1 = [int]$match.Groups[2].Value
	$x2 = [int]$match.Groups[3].Value; $y2 = [int]$match.Groups[4].Value
	return @{ x = [int](($x1 + $x2) / 2); y = [int](($y1 + $y2) / 2) }
}

switch ($Action) {
	'dump' {
		$xml = Get-Ui
		$texts = [regex]::Matches($xml, 'text="([^"]+)"') | ForEach-Object { $_.Groups[1].Value } | Where-Object { $_ -ne '' } | Select-Object -Unique
		$texts | Select-Object -First 30
	}
	'tap' {
		$xml = Get-Ui
		$bounds = Get-Bounds -Xml $xml -Needle $Value
		if (-not $bounds) { throw "text not found: $Value" }
		& $adb shell input tap $bounds.x $bounds.y
		"tapped '$Value' at $($bounds.x),$($bounds.y)"
	}
	'type' {
		& $adb shell input text $Value
		"typed '$Value'"
	}
	'texts' {
		$xml = Get-Ui
		$texts = [regex]::Matches($xml, 'text="([^"]+)"') | ForEach-Object { $_.Groups[1].Value } | Where-Object { $_ -ne '' } | Select-Object -Unique
		$texts -join " | "
	}
}
