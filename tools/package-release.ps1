param(
    [string]$Version = '1.0.0'
)
# 打发布包：exe + 文档 → release/TraceFind-<version>-win64.zip
# 注意：不要放在 dist/，那是 Vite 的产物目录，构建时会被清空。
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root

$outDir = Join-Path $root 'release'
$staging = Join-Path $outDir "TraceFind-$Version-win64"
if (Test-Path $staging) { Remove-Item $staging -Recurse -Force }
New-Item -ItemType Directory -Path $staging -Force | Out-Null

$exe = Join-Path $root 'src-tauri\target\release\tracefind.exe'
if (-not (Test-Path $exe)) { throw "找不到构建产物：$exe" }

Copy-Item $exe (Join-Path $staging 'TraceFind.exe')
Copy-Item (Join-Path $root 'docs\release-1.1.0.md') (Join-Path $staging 'RELEASE-NOTES.md')
Copy-Item (Join-Path $root 'docs\changelog-0.6.0.md') (Join-Path $staging 'CHANGELOG.md')
Copy-Item (Join-Path $root 'README.md') (Join-Path $staging 'README.md')

$zip = Join-Path $outDir "TraceFind-$Version-win64.zip"
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path (Join-Path $staging '*') -DestinationPath $zip -CompressionLevel Optimal

$hash = (Get-FileHash $zip -Algorithm SHA256).Hash
"$hash  TraceFind-$Version-win64.zip" |
    Out-File (Join-Path $outDir "TraceFind-$Version-win64.zip.sha256") -Encoding ASCII

"打包完成："
"  压缩包  $zip ({0:N1} MB)" -f ((Get-Item $zip).Length / 1MB)
"  SHA256  $hash"
