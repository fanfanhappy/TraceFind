param([int]$Port = 9229)
# 首次使用引导：完全空的配置目录跑一遍，截图并检查落库
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root

$base = Join-Path $env:TEMP 'tf-onboard'
$dataDir = Join-Path $base 'data'
$configDir = Join-Path $base 'config'
$webview = Join-Path $base 'webview'
foreach ($dir in @($base)) {
    if (Test-Path $dir) { Remove-Item $dir -Recurse -Force }
}
foreach ($dir in @($dataDir, $configDir, $webview)) {
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
}

# 首次运行：不写 settings.json，让后端用默认值（onboardingComplete = false）

$env:TRACEFIND_DATA_DIR = $dataDir
$env:TRACEFIND_CONFIG_DIR = $configDir
$env:WEBVIEW2_USER_DATA_FOLDER = $webview
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$Port"

$exe = Join-Path $root 'src-tauri\target\release\tracefind.exe'
$proc = Start-Process -FilePath $exe -PassThru
try {
    Start-Sleep -Seconds 5
    node (Join-Path $PSScriptRoot 'probe-onboarding.mjs') $Port
}
finally {
    if ($proc -and -not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
    Remove-Item $base -Recurse -Force -ErrorAction SilentlyContinue
}
