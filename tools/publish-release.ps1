param(
    [string]$Version = '1.1.0',
    [string]$Repo = 'fanfanhappy/TraceFind'
)
# 发布 GitHub Release 并上传安装包。
# 前置：gh auth login（需要 repo 权限），且本地已有 release/TraceFind-<Version>-win64.zip
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root

$tag = "v$Version"
$zip = Join-Path $root "release\TraceFind-$Version-win64.zip"
$notes = Join-Path $root "docs\release-$Version.md"

if (-not (Test-Path $zip)) { throw "找不到安装包：$zip（先运行 tools/package-release.ps1）" }
if (-not (Test-Path $notes)) { throw "找不到发布说明：$notes" }

& gh auth status 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) {
    throw 'gh 未登录：先执行 gh auth login'
}

$existing = & gh release view $tag --repo $Repo 2>$null
if ($LASTEXITCODE -eq 0) {
    Write-Host "Release $tag 已存在，改为上传/覆盖资产"
    & gh release upload $tag $zip --repo $Repo --clobber
} else {
    & gh release create $tag $zip --repo $Repo --title "TraceFind $Version" --notes-file $notes
}

if ($LASTEXITCODE -ne 0) { throw '创建 Release 失败' }
& gh release view $tag --repo $Repo
