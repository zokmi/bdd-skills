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
import sys


def _rgba(path):
    """讀取圖片並轉成 RGBA，回傳已載入的 Image。"""
    from PIL import Image
    with Image.open(path) as im:
        im.load()
        return im.convert("RGBA")


def check():
    """回報 Pillow 是否可用且支援 WebP。"""
    try:
        from PIL import features
        print(json.dumps({"ok": bool(features.check("webp"))}))
    except Exception:  # Pillow 未安裝或載入失敗
        print(json.dumps({"ok": False}))


def convert(src, dst):
    """把 src 無損轉成 dst（WebP），回報是否逐像素一致與前後大小。"""
    original = _rgba(src)
    os.makedirs(os.path.dirname(os.path.abspath(dst)), exist_ok=True)
    original.save(dst, "WEBP", lossless=True, quality=100, method=6, exact=True)
    restored = _rgba(dst)
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
