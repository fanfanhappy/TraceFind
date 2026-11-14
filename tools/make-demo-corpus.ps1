param(
    [string]$Root = (Join-Path $env:TEMP 'tf-shots\corpus')
)
# 生成一套**完全虚构**的演示语料，供截图与演示使用。
# 约定：仓库里出现的任何界面截图都必须来自这套语料，不得使用真实文件。
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)

$project = Join-Path $Root '示例项目'
$archive = Join-Path $Root '归档'
$assets = Join-Path $Root '资源'
New-Item -ItemType Directory -Path $project, $archive, $assets -Force | Out-Null

[System.IO.File]::WriteAllText((Join-Path $project '季度预算报告.md'), @'
# 2026 年第一季度预算报告

## 总体情况
本季度总体支出较预算低 4.2%，主要来自差旅与外包两项。

## 分项
- 研发：预算 120 万，实际 118.6 万
- 市场：预算 45 万，实际 47.3 万（超出 5.1%）
- 行政：预算 18 万，实际 16.4 万

## 下季度关注
1. 市场投放需要重新评估渠道结构
2. 研发外包比例控制在 30% 以内
'@, $utf8)

[System.IO.File]::WriteAllText((Join-Path $project '产品需求说明.md'), @'
# 产品需求说明

## 目标
把搜索入口做成随手可用的桌面工具。

## 核心场景
- 按文件名或拼音快速定位
- 正文里的关键词也能搜到
- 打开前先预览内容
'@, $utf8)

[System.IO.File]::WriteAllText((Join-Path $project '会议纪要.txt'), @'
项目周会纪要
时间：2026-03-12
议题：预算调整、发布节奏
结论：预算差额从市场费用中调剂。
'@, $utf8)

[System.IO.File]::WriteAllText((Join-Path $project 'config.json'), @'
{
  "project": "示例项目",
  "quarter": "2026-Q1",
  "budget": {
    "research": 1200000,
    "marketing": 450000,
    "admin": 180000
  },
  "alerts": [
    { "channel": "marketing", "overrun": 0.051 },
    { "channel": "admin", "overrun": -0.089 }
  ],
  "reviewed": true
}
'@, $utf8)

[System.IO.File]::WriteAllText((Join-Path $archive '旧版预算说明.md'), "# 旧版说明`n`n这是历史版本，已被取代。`n", $utf8)

# docx / png 交给脚本生成，避免在 PowerShell 里嵌 Python
$py = 'python'
$candidates = @(
    'C:\Users\Administrator\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe',
    "$env:LOCALAPPDATA\Programs\Python\Python312\python.exe"
)
foreach ($candidate in $candidates) {
    if (Test-Path $candidate) { $py = $candidate; break }
}

$docx = Join-Path $project '季度预算报告.docx'
if (-not (Test-Path $docx)) {
    & $py (Join-Path $PSScriptRoot 'make-demo-docx.py') $docx 2>$null | Out-Null
}
$png = Join-Path $assets '月度支出统计.png'
if (-not (Test-Path $png)) {
    & $py (Join-Path $PSScriptRoot 'make-demo-chart.py') $png 2>$null | Out-Null
}

$count = (Get-ChildItem $Root -Recurse -File | Measure-Object).Count
"演示语料已生成：$Root（$count 个文件）"
