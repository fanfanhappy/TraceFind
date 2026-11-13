param(
    [string]$Root = (Join-Path $env:TEMP 'tf-shots\corpus')
)
# 生成一套**完全虚构**的演示语料，供截图与演示使用。
# 约定：仓库里出现的任何界面截图都必须来自这套语料，不得使用真实文件。
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)

$project = Join-Path $Root '示例项目'
$archive = Join-Path $Root '归档'
New-Item -ItemType Directory -Path $project, $archive -Force | Out-Null

[System.IO.File]::WriteAllText((Join-Path $project '季度预算报告.md'), @'
# 2026 年第一季度预算报告

## 总体情况
本季度总体支出较预算低 4.2%，主要来自差旅与外包两项。

## 分项
- 研发：预算 120 万，实际 118.6 万
- 市场：预算 45 万，实际 47.3 万（超出 5.1%）
- 行政：预算 18 万，实际 16.4 万
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

[System.IO.File]::WriteAllText((Join-Path $archive '旧版预算说明.md'), "# 旧版说明`n`n这是历史版本，已被取代。`n", $utf8)

# 可选：用 python-docx 造一个 docx，让截图里出现"文档"类型
$py = Join-Path $env:LOCALAPPDATA 'Programs\Python\Python312\python.exe'
if (-not (Test-Path $py)) { $py = 'python' }
$docxPath = Join-Path $project '季度预算报告.docx'
if (-not (Test-Path $docxPath)) {
    $script = @"
try:
    from docx import Document
    doc = Document()
    doc.add_heading('季度预算报告', 0)
    doc.add_paragraph('本季度总体支出较预算低 4.2%，差旅与外包均有结余。')
    doc.add_heading('分项', level=1)
    for line in ['研发：预算 120 万，实际 118.6 万', '市场：预算 45 万，实际 47.3 万', '行政：预算 18 万，实际 16.4 万']:
        doc.add_paragraph(line, style='List Bullet')
    doc.save(r'$docxPath')
    print('docx ok')
except Exception as err:
    print('docx skipped:', err)
"@
    $tmp = Join-Path $env:TEMP 'tf-make-docx.py'
    [System.IO.File]::WriteAllText($tmp, $script, $utf8)
    & $py $tmp 2>$null | Out-Null
}

$count = (Get-ChildItem $Root -Recurse -File | Measure-Object).Count
"演示语料已生成：$Root（$count 个文件）"
