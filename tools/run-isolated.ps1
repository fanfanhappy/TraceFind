param(
    [int]$Port = 9224,
    [switch]$Keep
)
# 用隔离的索引库与配置跑端到端验证：不读也不写真实用户目录。
$ErrorActionPreference = 'Stop'
$root = Join-Path $env:TEMP ("aura-e2e-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
$corpus = Join-Path $root 'corpus'
$work = Join-Path $corpus 'Work'
$bench = Join-Path $corpus 'Workbench'
$dataDir = Join-Path $root 'data'
$configDir = Join-Path $root 'config'

New-Item -ItemType Directory -Path (Join-Path $work 'sub'), $bench, $dataDir, $configDir -Force | Out-Null

# 语料：目录边界（Work / Workbench）、同秒覆盖、提取失败各一份
Set-Content (Join-Path $work 'a.md') '本季度预算报告已提交' -Encoding UTF8
Set-Content (Join-Path $work 'sub\b.txt') '深层内容 托盘说明' -Encoding UTF8
Set-Content (Join-Path $bench 'c.md') '预算 不该被 Work 命中' -Encoding UTF8
Set-Content (Join-Path $corpus 'note.txt') 'v1 旧内容' -Encoding UTF8
[System.IO.File]::WriteAllBytes((Join-Path $corpus 'bad.docx'), [byte[]](1..64))
[System.IO.File]::WriteAllBytes((Join-Path $corpus 'tiny.png'), [Convert]::FromBase64String('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='))

$settings = @{
    theme = 'dark'; reducedMotion = $false; hotkey = 'Ctrl+Alt+Shift+F12'
    autostart = $false; alwaysOnTop = $false; closeToTray = $true; resultLimit = 8
    roots = @($corpus); excludedPaths = @(); contentIndex = $true; aiEnabled = $false
} | ConvertTo-Json -Depth 4
# 注意：必须写成无 BOM 的 UTF-8，serde_json 不接受 BOM
[System.IO.File]::WriteAllText((Join-Path $configDir 'settings.json'), $settings, (New-Object System.Text.UTF8Encoding($false)))

$env:TRACEFIND_DATA_DIR = $dataDir
$env:TRACEFIND_CONFIG_DIR = $configDir
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$Port"
# 独立 WebView2 数据目录：否则会与用户正在运行的实例抢同一个 user data folder
$env:WEBVIEW2_USER_DATA_FOLDER = Join-Path $root 'webview'
$env:AURA_E2E_CORPUS = $corpus

$exe = Join-Path $PSScriptRoot '..\src-tauri\target\release\tracefind.exe'
$process = Start-Process -FilePath $exe -PassThru -RedirectStandardOutput (Join-Path $root 'app.out') -RedirectStandardError (Join-Path $root 'app.err')

try {
    # 等调试端口起来
    $ready = $false
    for ($i = 0; $i -lt 60 -and -not $ready; $i++) {
        Start-Sleep -Milliseconds 250
        try {
            $null = Invoke-WebRequest "http://127.0.0.1:$Port/json" -UseBasicParsing -TimeoutSec 2
            $ready = $true
        } catch { }
    }
    if (-not $ready) { throw '调试端口未就绪' }

    & node (Join-Path $PSScriptRoot 'verify-e2e.mjs') $Port
    $code = $LASTEXITCODE
}
finally {
    # 只结束本次启动的进程：不能按进程名一刀切，否则会杀掉用户正在用的 AURA Search
    if ($process -and -not $process.HasExited) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
    if ($code -ne 0) {
        Write-Host '--- app.err ---'
        Get-Content (Join-Path $root 'app.err') -ErrorAction SilentlyContinue | Select-Object -Last 20
    }
    if (-not $Keep) { Remove-Item $root -Recurse -Force -ErrorAction SilentlyContinue }
    else { Write-Host "保留现场：$root" }
}

exit $code
