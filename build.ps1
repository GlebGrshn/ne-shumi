# Build zip for Yandex Games console upload.
# Usage: powershell -ExecutionPolicy Bypass -File build.ps1
$root = $PSScriptRoot
$out = Join-Path $root "dist"
$zip = Join-Path $root "neshumi.zip"

if (Test-Path $out) { Remove-Item -Recurse -Force $out }
New-Item -ItemType Directory -Force $out | Out-Null

Copy-Item (Join-Path $root "index.html") $out
Copy-Item -Recurse (Join-Path $root "js") (Join-Path $out "js")
$assets = Join-Path $root "assets"
if (Test-Path $assets) { Copy-Item -Recurse $assets (Join-Path $out "assets") }

$raw = (Get-ChildItem $out -Recurse -File | Measure-Object -Property Length -Sum).Sum
Write-Host ("Uncompressed: {0:N1} MB (Yandex limit 100 MB)" -f ($raw / 1MB))

if (Test-Path $zip) { Remove-Item -Force $zip }
Compress-Archive -Path (Join-Path $out "*") -DestinationPath $zip

Remove-Item -Recurse -Force $out
Write-Host "Done: $zip"
