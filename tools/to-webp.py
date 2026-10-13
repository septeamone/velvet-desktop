#!/usr/bin/env python3
"""Переводит логотипы каналов и станций из PNG/JPEG в WebP (в 2–3 раза легче). Запуск из корня проекта: python tools/to-webp.py"""
import os, sys
from pathlib import Path
from PIL import Image

root = Path(__file__).resolve().parent.parent / "public"
before = after = 0
for folder in ("logos", "radio"):
    for f in sorted((root / folder).glob("*")):
        if f.suffix.lower() not in (".png", ".jpg", ".jpeg"):
            continue
        im = Image.open(f)
        im = im.convert("RGBA") if (im.mode in ("RGBA", "LA", "P") or "transparency" in im.info) else im.convert("RGB")
        out = f.with_suffix(".webp")
        im.save(out, "WEBP", quality=88, method=6)
        before += f.stat().st_size
        after += out.stat().st_size
        f.unlink()
print(f"было {before/1024:.0f} КБ, стало {after/1024:.0f} КБ")
