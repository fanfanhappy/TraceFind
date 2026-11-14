param([int]$Port = 9228)
# 用一张真含文字的图片验证 OCR 链路与「OCR」标签
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root

$base = Join-Path $env:TEMP 'tf-ocr'
$corpus = Join-Path $base 'corpus'
$dataDir = Join-Path $base 'data'
$configDir = Join-Path $base 'config'
$webview = Join-Path $base 'webview'
foreach ($dir in @($corpus, $dataDir, $configDir, $webview)) {
    if (Test-Path $dir) { Remove-Item $dir -Recurse -Force }
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
}

# 生成一张 900×600 的报价单截图（中文字体，内容虚构）
$py = 'C:\Users\Administrator\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe'
$script = Join-Path $base 'make.py'
@'
from PIL import Image, ImageDraw, ImageFont
import sys
img = Image.new('RGB', (900, 600), 'white')
d = ImageDraw.Draw(img)
font = ImageFont.truetype(r'C:\Windows\Fonts\msyh.ttc', 34)
small = ImageFont.truetype(r'C:\Windows\Fonts\msyh.ttc', 26)
d.text((60, 60), '报价单', font=font, fill='black')
d.text((60, 160), '项目：示例项目二期', font=small, fill='black')
d.text((60, 220), '总计：12800 元', font=small, fill='black')
d.text((60, 280), '付款方式：分两期', font=small, fill='black')
d.text((60, 340), '有效期：30 天', font=small, fill='black')
img.save(sys.argv[1])
'@ | Out-File -FilePath $script -Encoding UTF8
& $py $script (Join-Path $corpus '报价单.png')

$settings = @{
    theme = 'dark'; reducedMotion = $false; hotkey = 'Ctrl+Alt+Shift+F9'
    autostart = $false; alwaysOnTop = $false; closeToTray = $true; resultLimit = 8
    roots = @($corpus); excludedPaths = @(); contentIndex = $true
    semanticEnabled = $false; ocrEnabled = $true; assistantEnabled = $false
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
    node (Join-Path $PSScriptRoot 'probe-ocr.mjs') $Port
}
finally {
    if ($proc -and -not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
    Remove-Item $base -Recurse -Force -ErrorAction SilentlyContinue
}
