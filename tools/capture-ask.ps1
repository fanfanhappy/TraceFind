param(
    [int]$Port = 9225,
    [string]$OutDir = 'docs\screens'
)
# 用真实云端 API 截一张 AI 问答面板，仍只用假语料。
# 前置：设置环境变量（只存在当前进程，不落盘）
#   $env:TRACEFIND_AI_BASE  = https://api.openai.com/v1
#   $env:TRACEFIND_AI_KEY   = sk-...
#   $env:TRACEFIND_AI_MODEL = gpt-4o-mini
# 用法：powershell -File tools/capture-ask.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root

if (-not $env:TRACEFIND_AI_KEY) { throw '缺少 TRACEFIND_AI_KEY' }
if (-not $env:TRACEFIND_AI_BASE) { throw '缺少 TRACEFIND_AI_BASE（例如 https://api.openai.com/v1）' }
$model = if ($env:TRACEFIND_AI_MODEL) { $env:TRACEFIND_AI_MODEL } else { 'gpt-4o-mini' }

$base = Join-Path $env:TEMP 'tf-ask'
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
    theme = 'dark'; reducedMotion = $false; hotkey = 'Ctrl+Alt+Shift+F11'
    autostart = $false; alwaysOnTop = $false; closeToTray = $true; resultLimit = 8
    roots = @($corpus); excludedPaths = @(); contentIndex = $true
    semanticEnabled = $false; ocrEnabled = $false; keepOpenAfterOpen = $true
    assistantEnabled = $true
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
    node (Join-Path $PSScriptRoot 'capture-ask.mjs') $Port $OutDir $env:TRACEFIND_AI_BASE $env:TRACEFIND_AI_KEY $model
}
finally {
    if ($proc -and -not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
    # 临时目录里有 DPAPI 密文，截完即删
    Remove-Item $base -Recurse -Force -ErrorAction SilentlyContinue
}
