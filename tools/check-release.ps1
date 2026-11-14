param(
    [string]$Version = '',
    [switch]$VerifyDownload
)
# 发布一致性检查：版本号、tag、zip、sha256、Release 资产、README 链接、latest 标记
# 用法：
#   powershell -File tools\check-release.ps1
#   powershell -File tools\check-release.ps1 -Version 2.0.0 -VerifyDownload
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root

$results = New-Object System.Collections.Generic.List[object]
function Check([string]$name, [bool]$ok, [string]$detail = '') {
    $results.Add([pscustomobject]@{ Name = $name; Ok = $ok; Detail = $detail })
}

# ---------- 版本号 ----------
$pkg = Get-Content 'package.json' -Raw -Encoding UTF8 | ConvertFrom-Json
$cargo = ''
foreach ($line in Get-Content 'src-tauri\Cargo.toml' -Encoding UTF8) {
    if ($line -match '^version\s*=\s*"([^"]+)"') { $cargo = $Matches[1]; break }
}
$conf = Get-Content 'src-tauri\tauri.conf.json' -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not $Version) { $Version = $pkg.version }
Check 'package.json 版本' ($pkg.version -eq $Version) "$($pkg.version)"
Check 'Cargo.toml 版本' ($cargo -eq $Version) "$cargo"
Check 'tauri.conf.json 版本' ($conf.version -eq $Version) "$($conf.version)"

$tag = "v$Version"
Check 'tag 名' ($tag -match '^v\d+\.\d+\.\d+$') $tag

# ---------- git ----------
$localTag = (git rev-parse -q --verify "refs/tags/$tag" 2>$null)
Check '本地 tag 存在' ([bool]$localTag) $(if ($localTag) { $localTag.Substring(0, 7) } else { '缺失' })

$head = (git rev-parse HEAD).Trim()
$isAncestor = $false
if ($localTag) {
    git merge-base --is-ancestor $localTag $head 2>$null
    $isAncestor = ($LASTEXITCODE -eq 0)
}
Check 'tag 指向仓库历史' $isAncestor $(if ($isAncestor) { 'HEAD 或祖先' } else { 'tag 不在当前分支历史里' })

$remoteTag = (git ls-remote --tags origin "refs/tags/$tag" 2>$null)
Check '远程 tag 存在' ([bool]$remoteTag) $(if ($remoteTag) { '已推送' } else { '未推送' })

# ---------- 本地产物 ----------
$zip = "release\TraceFind-$Version-win64.zip"
$shaFile = "$zip.sha256"
$zipOk = Test-Path $zip
Check '本地 zip' $zipOk $(if ($zipOk) { '{0:N2} MB' -f ((Get-Item $zip).Length / 1MB) } else { $zip })

$shaOk = $false
$shaDetail = ''
if ($zipOk -and (Test-Path $shaFile)) {
    $expected = (Get-Content $shaFile -Raw -Encoding ASCII).Trim().Split(' ')[0].ToUpper()
    $actual = (Get-FileHash $zip -Algorithm SHA256).Hash.ToUpper()
    $shaOk = ($expected -eq $actual)
    $shaDetail = $actual
}
Check 'sha256 一致' $shaOk $(if ($shaDetail) { $shaDetail.Substring(0, 16) + '…' } else { '缺少 .sha256 或 zip' })

$setup = "release\TraceFind-$Version-win64-setup.exe"
$setupShaFile = "$setup.sha256"
$setupOk = Test-Path $setup
Check '本地安装包' $setupOk $(if ($setupOk) { '{0:N1} MB' -f ((Get-Item $setup).Length / 1MB) } else { $setup })

$setupDetail = ''
if ($setupOk -and (Test-Path $setupShaFile)) {
    $expected = (Get-Content $setupShaFile -Raw -Encoding ASCII).Trim().Split(' ')[0].ToUpper()
    $actual = (Get-FileHash $setup -Algorithm SHA256).Hash.ToUpper()
    $setupDetail = $actual
    Check '安装包 sha256 一致' ($expected -eq $actual) ($actual.Substring(0, 16) + '…')
} else {
    Check '安装包 sha256 一致' $false '缺少 .sha256 或 setup.exe'
}

# ---------- 文档 ----------
$notes = "docs\release-$Version.md"
Check '发布说明存在' (Test-Path $notes) $notes

$readme = Get-Content 'README.md' -Raw -Encoding UTF8
Check 'README 链接到本版说明' ($readme.Contains("release-$Version.md")) $(if ($readme.Contains("release-$Version.md")) { "docs/release-$Version.md" } else { 'README 未链接本版说明' })

# ---------- GitHub Release ----------
$token = $null
try {
    $cred = "protocol=https`nhost=github.com`n`n" | git credential fill 2>$null
    $token = ($cred -split "`n" | Where-Object { $_ -like 'password=*' }) -replace '^password=', ''
} catch { }

if (-not $token) {
    Check 'GitHub 凭据' $false '未取到凭据，跳过远程检查'
} else {
    $headers = @{ Authorization = "token $token"; 'User-Agent' = 'tracefind'; Accept = 'application/vnd.github+json' }
    $repo = 'fanfanhappy/TraceFind'

    $release = $null
    try {
        $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases/tags/$tag" -Headers $headers -TimeoutSec 30
    } catch { }

    Check 'Release 存在' ([bool]$release) $tag
    if ($release) {
        Check 'Release 已发布' (-not $release.draft) $(if ($release.draft) { 'draft' } else { 'published' })
        $names = @($release.assets | ForEach-Object { $_.name })
        Check '资产 zip' ($names -contains "TraceFind-$Version-win64.zip") ($names -join ', ')
        Check '资产 sha256' ($names -contains "TraceFind-$Version-win64.zip.sha256") $(if ($names -contains "TraceFind-$Version-win64.zip.sha256") { '已上传' } else { '缺少 .sha256' })
        Check '资产 setup' ($names -contains "TraceFind-$Version-win64-setup.exe") $(if ($names -contains "TraceFind-$Version-win64-setup.exe") { '已上传' } else { '缺少 setup.exe' })
        Check '资产 setup sha256' ($names -contains "TraceFind-$Version-win64-setup.exe.sha256") $(if ($names -contains "TraceFind-$Version-win64-setup.exe.sha256") { '已上传' } else { '缺少 setup .sha256' })

        try {
            $latest = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases/latest" -Headers $headers -TimeoutSec 30
            Check 'latest 指向本版本' ($latest.tag_name -eq $tag) "$($latest.tag_name)"
        } catch {
            Check 'latest 指向本版本' $false '读取失败'
        }

        if ($VerifyDownload -and $shaDetail) {
            $tmp = Join-Path $env:TEMP "tf-check-$Version.zip"
            $remote = ''
            $downloaded = $false
            try {
                # 网络不稳时 curl 可能只下到一半，必须按体积确认完整再比对哈希
                for ($attempt = 1; $attempt -le 3 -and -not $downloaded; $attempt++) {
                    Remove-Item $tmp -Force -ErrorAction SilentlyContinue
                    curl.exe -s -L --retry 3 --retry-delay 2 --max-time 600 -o $tmp "https://github.com/$repo/releases/download/$tag/TraceFind-$Version-win64.zip" | Out-Null
                    if ((Test-Path $tmp) -and ((Get-Item $tmp).Length -eq (Get-Item $zip).Length)) {
                        $downloaded = $true
                    } else {
                        Start-Sleep -Seconds 2
                    }
                }
                if ($downloaded) {
                    $remote = (Get-FileHash $tmp -Algorithm SHA256).Hash.ToUpper()
                    Check '远端 zip 与本地一致' ($remote -eq $shaDetail) $remote.Substring(0, 16)
                } else {
                    Check '远端 zip 与本地一致' $false '下载不完整（已重试 3 次）'
                }
            } catch {
                Check '远端 zip 与本地一致' $false '下载失败'
            } finally {
                Remove-Item $tmp -Force -ErrorAction SilentlyContinue
            }

            if ($setupDetail) {
                $tmpSetup = Join-Path $env:TEMP "tf-check-$Version-setup.exe"
                $remoteSetup = ''
                $gotSetup = $false
                try {
                    for ($attempt = 1; $attempt -le 3 -and -not $gotSetup; $attempt++) {
                        Remove-Item $tmpSetup -Force -ErrorAction SilentlyContinue
                        curl.exe -s -L --retry 3 --retry-delay 2 --max-time 600 -o $tmpSetup "https://github.com/$repo/releases/download/$tag/TraceFind-$Version-win64-setup.exe" | Out-Null
                        if ((Test-Path $tmpSetup) -and ((Get-Item $tmpSetup).Length -eq (Get-Item $setup).Length)) {
                            $gotSetup = $true
                        } else {
                            Start-Sleep -Seconds 2
                        }
                    }
                    if ($gotSetup) {
                        $remoteSetup = (Get-FileHash $tmpSetup -Algorithm SHA256).Hash.ToUpper()
                        Check '远端安装包与本地一致' ($remoteSetup -eq $setupDetail) $remoteSetup.Substring(0, 16)
                    } else {
                        Check '远端安装包与本地一致' $false '下载不完整（已重试 3 次）'
                    }
                } catch {
                    Check '远端安装包与本地一致' $false '下载失败'
                } finally {
                    Remove-Item $tmpSetup -Force -ErrorAction SilentlyContinue
                }
            }
        }
    }
}

# ---------- 输出 ----------
$width = ($results | ForEach-Object { $_.Name.Length } | Measure-Object -Maximum).Maximum
foreach ($item in $results) {
    $mark = if ($item.Ok) { 'OK  ' } else { 'FAIL' }
    $name = $item.Name.PadRight($width)
    Write-Host ("[{0}] {1}  {2}" -f $mark, $name, $item.Detail)
}

$failed = @($results | Where-Object { -not $_.Ok })
Write-Host ''
if ($failed.Count -gt 0) {
    Write-Host ("{0} 项未通过：{1}" -f $failed.Count, (($failed | ForEach-Object { $_.Name }) -join ' / ')) -ForegroundColor Red
    exit 1
}
Write-Host "全部通过：$tag" -ForegroundColor Green
