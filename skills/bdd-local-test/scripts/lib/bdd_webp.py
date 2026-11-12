"""bdd-local-test 的 WebP 輔助程式：以 Pillow 做無損轉檔並逐像素驗證。

用法：
  python bdd_webp.py check
      印出 {"ok": true|false}：Pillow 是否支援 WebP。
  python bdd_webp.py convert <來源> <目的地>
      無損轉成 WebP（exact=True 保留透明像素的 RGB），再解碼回 RGBA 與原圖逐位元組比對。
      印出 {"identical": bool, "sourceBytes": n, "webpBytes": n}；失敗時印 {"error": "..."} 並以 1 結束。

輸出一律是 ASCII 跳脫的 JSON，避免 Windows 主控台編碼把中文檔名弄亂。
"""
import json
import os
import re
import sys


INPUT_FORMATS = {".png": "PNG", ".jpg": "JPEG", ".jpeg": "JPEG", ".bmp": "BMP"}
MAX_PIXELS = 32_000_000
MIN_PILLOW_VERSION = (13, 0, 0)


def _supported_pillow(version):
    match = re.fullmatch(r"(\d+)\.(\d+)\.(\d+)", version)
    return match is not None and tuple(map(int, match.groups())) >= MIN_PILLOW_VERSION


def _rgba(path, image_format):
    """讀取圖片並轉成 RGBA，回傳已載入的 Image。"""
    from PIL import Image
    with open(path, "rb") as source:
        # Pillow 可能先把 16 位元 RGB PNG 降位再呈現為 RGB，必須檢查原始 IHDR。
        if image_format == "PNG":
            header = source.read(25)
            if header.startswith(b"\x89PNG\r\n\x1a\n") and len(header) == 25 and header[24] > 8:
                raise ValueError("unsupported PNG bit depth for lossless WebP")
            source.seek(0)
        with Image.open(source, formats=[image_format]) as im:
            if im.width * im.height > MAX_PIXELS:
                raise ValueError("image exceeds the pixel limit for lossless WebP")
            if getattr(im, "n_frames", 1) != 1:
                raise ValueError("only single-frame images can be converted to lossless WebP")
            if im.mode not in ("1", "L", "LA", "P", "RGB", "RGBA"):
                raise ValueError("unsupported image mode for lossless WebP: " + im.mode)
            return im.convert("RGBA")


def check():
    """回報 Pillow 是否可用且支援 WebP。"""
    try:
        from PIL import __version__, features
        print(json.dumps({
            "ok": _supported_pillow(__version__) and bool(features.check("webp")),
            "version": __version__,
        }))
    except Exception:  # Pillow 未安裝或載入失敗
        print(json.dumps({"ok": False}))


def convert(src, dst):
    """把 src 無損轉成 dst（WebP），回報是否逐像素一致與前後大小。"""
    from PIL import __version__
    if not _supported_pillow(__version__):
        raise ValueError("lossless WebP requires Pillow 13.0.0 or later")
    image_format = INPUT_FORMATS.get(os.path.splitext(src)[1].lower())
    if image_format is None:
        raise ValueError("unsupported image file extension for lossless WebP")
    original = _rgba(src, image_format)
    os.makedirs(os.path.dirname(os.path.abspath(dst)), exist_ok=True)
    original.save(dst, "WEBP", lossless=True, quality=100, method=6, exact=True)
    restored = _rgba(dst, "WEBP")
    identical = original.size == restored.size and original.tobytes() == restored.tobytes()
    print(json.dumps({
        "identical": identical,
        "sourceBytes": os.path.getsize(src),
        "webpBytes": os.path.getsize(dst),
    }))


def main(argv):
    """解析命令列並執行對應動作；回傳 exit code。"""
    try:
        if len(argv) == 2 and argv[1] == "check":
            check()
            return 0
        if len(argv) == 4 and argv[1] == "convert":
            convert(argv[2], argv[3])
            return 0
        print(json.dumps({"error": "usage: bdd_webp.py check | convert <src> <dst>"}))
        return 2
    except Exception as exc:  # 任何轉檔錯誤都以 JSON 回報
        print(json.dumps({"error": str(exc)}))
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
