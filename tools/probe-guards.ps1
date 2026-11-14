param([int]$Port = 9227, [string]$OutDir = 'release')
# 起一个隔离实例并跑行为探针：不读写真实索引
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root

$base = Join-Path $env:TEMP 'tf-probe'
$corpus = Join-Path $base 'corpus'
$dataDir = Join-Path $base 'data'
$configDir = Join-Path $base 'config'
$webview = Join-Path $base 'webview'
foreach ($dir in @($dataDir, $configDir, $webview)) {
    if (Test-Path $dir) { Remove-Item $dir -Recurse -Force }
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
}
if (-not (Test-Path (Join-Path $corpus '示例项目'))) {
    & (Join-Path $PSScriptRoot 'make-demo-corpus.ps1') -Root $corpus
}

$settings = @{
    theme = 'dark'; reducedMotion = $false; hotkey = 'Ctrl+Alt+Shift+F10'
    autostart = $false; alwaysOnTop = $false; closeToTray = $true; resultLimit = 8
    roots = @($corpus); excludedPaths = @(); contentIndex = $true
    semanticEnabled = $false; ocrEnabled = $false; assistantEnabled = $false
} | ConvertTo-Json -Depth 4
[System.IO.File]::WriteAllText((Join-Path $configDir 'settings.json'), $settings, (New-Object System.Text.UTF8Encoding($false)))

$env:TRACEFIND_DATA_DIR = $dataDir
$env:TRACEFIND_CONFIG_DIR = $configDir
$env:WEBVIEW2_USER_DATA_FOLDER = $webview
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$Port"

$exe = Join-Path $root 'src-tauri\target\release\tracefind.exe'
$proc = Start-Process -FilePath $exe -PassThru
try {
    Start-Sleep -Seconds 5
    node (Join-Path $PSScriptRoot 'probe-guards.mjs') $Port
}
finally {
    if ($proc -and -not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
    Remove-Item $base -Recurse -Force -ErrorAction SilentlyContinue
}
