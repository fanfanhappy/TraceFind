param(
    [int]$Port = 9225,
    [string]$OutDir = 'docs\screens'
)
# 用假语料启动一个隔离实例，并截图（截图里不会出现真实文件名）
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root

$base = Join-Path $env:TEMP 'tf-shots'
$corpus = Join-Path $base 'corpus'
$dataDir = Join-Path $base 'data'
$configDir = Join-Path $base 'config'
$webview = Join-Path $base 'webview'
foreach ($dir in @($dataDir, $configDir, $webview)) {
    if (Test-Path $dir) { Remove-Item $dir -Recurse -Force }
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
}

$settings = @{
    theme = 'dark'; reducedMotion = $false; hotkey = 'Ctrl+Alt+Shift+F11'
    autostart = $false; alwaysOnTop = $false; closeToTray = $true; resultLimit = 8
    roots = @($corpus); excludedPaths = @(); contentIndex = $true
    semanticEnabled = $false; ocrEnabled = $false; keepOpenAfterOpen = $true
} | ConvertTo-Json -Depth 4
[System.IO.File]::WriteAllText((Join-Path $configDir 'settings.json'), $settings, (New-Object System.Text.UTF8Encoding($false)))

$env:TRACEFIND_DATA_DIR = $dataDir
$env:TRACEFIND_CONFIG_DIR = $configDir
$env:WEBVIEW2_USER_DATA_FOLDER = $webview
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$Port"

$exe = Join-Path $root 'src-tauri\target\release\tracefind.exe'
$proc = Start-Process -FilePath $exe -PassThru

try {
    $ready = $false
    for ($i = 0; $i -lt 60 -and -not $ready; $i++) {
        Start-Sleep -Milliseconds 250
        try {
            $null = Invoke-WebRequest "http://127.0.0.1:$Port/json" -UseBasicParsing -TimeoutSec 2
            $ready = $true
        } catch { }
    }
    if (-not $ready) { throw '调试端口未就绪' }

    if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }
    node (Join-Path $PSScriptRoot 'capture-screens.mjs') $Port $OutDir
}
finally {
    if ($proc -and -not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
}
