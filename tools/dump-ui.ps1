# Print the visible view tree of the app on the emulator, one line per view.
param(
	[string]$Package = "dev.tatudrag0n.dshmobile"
)
$adb = "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe"
& $adb shell uiautomator dump /sdcard/ui.xml | Out-Null
$xml = & $adb shell cat /sdcard/ui.xml
$lines = @()
foreach ($tag in [regex]::Matches($xml, '<node[^>]*>')) {
	$value = $tag.Value
	$cls = [regex]::Match($value, 'class="([^"]*)"').Groups[1].Value
	$txt = [regex]::Match($value, 'text="([^"]*)"').Groups[1].Value
	$desc = [regex]::Match($value, 'content-desc="([^"]*)"').Groups[1].Value
	$bounds = [regex]::Match($value, 'bounds="([^"]*)"').Groups[1].Value
	$pkg = [regex]::Match($value, 'package="([^"]*)"').Groups[1].Value
	if ($pkg -ne $Package) { continue }
	if (-not $txt -and -not $desc -and $cls -eq "android.view.View") { continue }
	$lines += ("{0,-26} text='{1}' desc='{2}' {3}" -f $cls, $txt, $desc, $bounds)
}
$lines | Select-Object -First 30
