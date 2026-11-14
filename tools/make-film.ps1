param(
    [int]$Fps = 30,
    [double]$Seconds = 20,
    [string]$Out = 'release\promo\tracefind-promo-20s.mp4',
    [int]$Port = 9337
)
# 渲染宣传短片：docs/assets/promo-film.html → MP4
# 需要：Edge（headless CDP）、Python 的 imageio-ffmpeg（或 PATH 里的 ffmpeg）
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root

$edge = @(
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $edge) { throw '找不到 msedge.exe' }

$ffmpeg = $null
$py = @(
    'C:\Users\Administrator\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe',
    "$env:LOCALAPPDATA\Programs\Python\Python312\python.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if ($py) {
    $ffmpeg = & $py -c "import imageio_ffmpeg;print(imageio_ffmpeg.get_ffmpeg_exe())" 2>$null
}
if (-not $ffmpeg -or -not (Test-Path $ffmpeg)) {
    $ffmpeg = (Get-Command ffmpeg -ErrorAction SilentlyContinue).Source
}
if (-not $ffmpeg) { throw '找不到 ffmpeg（pip install imageio-ffmpeg 或安装到 PATH）' }

$frames = Join-Path $root 'release\promo\frames'
$profile = Join-Path $env:TEMP 'tf-film-profile'
if (Test-Path $profile) { Remove-Item $profile -Recurse -Force }

$url = 'file:///' + ((Resolve-Path 'docs\assets\promo-film.html').Path -replace '\\', '/')
# headless 只允许一个 target：先开空白页，再由 CDP 导航
$proc = Start-Process -FilePath $edge -ArgumentList @(
    '--headless=new', "--remote-debugging-port=$Port", '--disable-gpu',
    '--no-first-run', "--user-data-dir=$profile", 'about:blank'
) -PassThru

try {
    Start-Sleep -Seconds 4
    node (Join-Path $PSScriptRoot 'render-film.mjs') $Port $frames $Fps $Seconds $url
    if ($LASTEXITCODE -ne 0) { throw '逐帧渲染失败' }

    $outPath = Join-Path $root $Out
    & $ffmpeg -y -loglevel error -framerate $Fps `
        -i (Join-Path $frames 'frame_%04d.jpg') `
        -vf "scale=in_range=full:out_range=tv,format=yuv420p" `
        -c:v libx264 -preset slow -crf 18 -color_range tv -movflags +faststart $outPath
    if ($LASTEXITCODE -ne 0) { throw 'ffmpeg 编码失败' }

    "完成：$outPath ({0:N2} MB)" -f ((Get-Item $outPath).Length / 1MB)
}
finally {
    if ($proc -and -not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
    Remove-Item $profile -Recurse -Force -ErrorAction SilentlyContinue
}
