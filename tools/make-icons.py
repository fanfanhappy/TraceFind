"""从品牌图生成 Tauri 需要的图标集：PNG 各尺寸、ICO 多尺寸、托盘图标。

用法：python tools/make-icons.py
"""
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "docs" / "assets" / "tracefind-logo.png"
ICONS = ROOT / "src-tauri" / "icons"


def knock_out_white(img: Image.Image) -> Image.Image:
    """把近白背景变透明（保留薄荷色图形与深色圆角方块）。"""
    rgba = img.convert("RGBA")
    pixels = rgba.load()
    width, height = rgba.size
    for y in range(height):
        for x in range(width):
            r, g, b, a = pixels[x, y]
            if r > 238 and g > 238 and b > 238:
                pixels[x, y] = (r, g, b, 0)
    return rgba


def square(img: Image.Image) -> Image.Image:
    """裁成正方形（原图已方形，这里只做保险）。"""
    width, height = img.size
    side = min(width, height)
    left = (width - side) // 2
    top = (height - side) // 2
    return img.crop((left, top, left + side, top + side))


def main() -> None:
    ICONS.mkdir(parents=True, exist_ok=True)
    base = square(knock_out_white(Image.open(SOURCE)))

    # Tauri 默认读取这四张
    for size in (32, 128, 256):
        name = "128x128@2x.png" if size == 256 else f"{size}x{size}.png"
        base.resize((size, size), Image.LANCZOS).save(ICONS / name)

    base.resize((512, 512), Image.LANCZOS).save(ICONS / "icon.png")

    # 托盘图标：小尺寸下细节会糊，单独用 32 并保持透明底
    tray = base.resize((32, 32), Image.LANCZOS)
    tray.save(ICONS / "tray.png")

    # Windows ICO：包含多档尺寸，任务栏/资源管理器各自取合适的
    sizes = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
    base.save(ICONS / "icon.ico", format="ICO", sizes=sizes)

    print("已生成：", ", ".join(sorted(p.name for p in ICONS.glob("*"))))


if __name__ == "__main__":
    main()
