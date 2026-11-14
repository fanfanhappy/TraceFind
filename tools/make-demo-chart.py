"""生成一张演示用柱状图（虚构数据），避免截图出现真实图片。"""
import sys
from pathlib import Path

from PIL import Image, ImageDraw

target = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("月度支出统计.png")
target.parent.mkdir(parents=True, exist_ok=True)

img = Image.new("RGB", (1100, 640), "#141821")
draw = ImageDraw.Draw(img)
draw.text((48, 36), "Monthly spend (demo)", fill="#b8f2d8")

bars = [("Jan", 0.62), ("Feb", 0.74), ("Mar", 0.55), ("Apr", 0.88), ("May", 0.71), ("Jun", 0.66)]
base_y, top_y = 560, 120
for index, (label, ratio) in enumerate(bars):
    x = 110 + index * 150
    height = int((base_y - top_y) * ratio)
    draw.rectangle([x, base_y - height, x + 78, base_y], fill="#7fd6b0")
    draw.text((x + 18, base_y + 16), label, fill="#9aa3b2")

draw.line([80, base_y, 1020, base_y], fill="#2a303c", width=2)
img.save(target)
print(f"chart -> {target}")
