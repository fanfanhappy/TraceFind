"""生成演示用 docx（虚构内容），用于文档预览截图。"""
import sys
from pathlib import Path

from docx import Document

target = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("季度预算报告.docx")
target.parent.mkdir(parents=True, exist_ok=True)

doc = Document()
doc.add_heading("季度预算报告", 0)
doc.add_paragraph("本季度总体支出较预算低 4.2%，差旅与外包均有结余。")
doc.add_heading("分项", level=1)
for line in [
    "研发：预算 120 万，实际 118.6 万",
    "市场：预算 45 万，实际 47.3 万（超出 5.1%）",
    "行政：预算 18 万，实际 16.4 万",
]:
    doc.add_paragraph(line, style="List Bullet")
doc.add_heading("下季度关注", level=1)
doc.add_paragraph("市场投放渠道结构需要重新评估。")
doc.save(target)
print(f"docx -> {target}")
