param(
    [string]$Version = '',
    [string]$Makensis = ''
)
# 用 NSIS 打安装包：可选安装目录 + 开始菜单/桌面快捷方式（沿用应用图标）。
# 依赖 makensis：优先用 Tauri 缓存里的 NSIS（%LOCALAPPDATA%\tauri\NSIS）。
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root

if (-not $Version) {
    $Version = (Get-Content (Join-Path $root 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
}

if (-not $Makensis) {
    $candidates = @(
        (Join-Path $env:LOCALAPPDATA 'tauri\NSIS\makensis.exe'),
        (Get-Command makensis.exe -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Source)
    ) | Where-Object { $_ -and (Test-Path $_) }
    $Makensis = $candidates | Select-Object -First 1
}
if (-not $Makensis -or -not (Test-Path $Makensis)) {
    throw '找不到 makensis。先跑一次 `npx tauri build --bundles nsis` 让 Tauri 下载 NSIS，或用 -Makensis 指定路径。'
}

$exe = Join-Path $root 'src-tauri\target\release\tracefind.exe'
if (-not (Test-Path $exe)) { throw "找不到构建产物：$exe（先 cargo build --release --features custom-protocol）" }

$outDir = Join-Path $root 'release'
New-Item -ItemType Directory -Path $outDir -Force | Out-Null
$setup = Join-Path $outDir "TraceFind-$Version-win64-setup.exe"
if (Test-Path $setup) { Remove-Item $setup -Force }

$template = Get-Content (Join-Path $root 'tools\installer\installer.nsi') -Raw -Encoding UTF8
$icon = Join-Path $root 'src-tauri\icons\icon.ico'
$script = $template.
    Replace('{{VERSION}}', $Version).
    Replace('{{SRC_EXE}}', $exe).
    Replace('{{ICON}}', $icon).
    Replace('{{OUT}}', $setup)

$work = Join-Path $env:TEMP 'tracefind-nsis'
New-Item -ItemType Directory -Path $work -Force | Out-Null
$nsi = Join-Path $work 'installer.nsi'
$utf8Bom = New-Object System.Text.UTF8Encoding($true)
[System.IO.File]::WriteAllText($nsi, $script, $utf8Bom)

& $Makensis /V2 $nsi
if ($LASTEXITCODE -ne 0 -or -not (Test-Path $setup)) { throw "makensis 失败（exit $LASTEXITCODE）" }

$hash = (Get-FileHash $setup -Algorithm SHA256).Hash
"$hash  TraceFind-$Version-win64-setup.exe" |
    Out-File (Join-Path $outDir "TraceFind-$Version-win64-setup.exe.sha256") -Encoding ASCII

$size = [math]::Round((Get-Item $setup).Length / 1MB, 1)
"安装包完成："
"  文件    $setup ($size MB)"
"  SHA256  $hash"
