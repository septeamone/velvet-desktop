#!/usr/bin/env python3
"""Собирает файл дополнительных каналов для тех, кому их надо дать лично (не через GitHub).
Берёт локальный src/data/paid.json (его нет в репозитории) и логотипы public/logos/p-*, кладёт логотипы внутрь файла
и пишет рядом «Установить каналы.bat»: он копирует файл туда, откуда программа его читает.
Запуск: python tools/pack-extra-channels.py <папка вывода>"""
import base64, json, sys
from pathlib import Path

root = Path(__file__).resolve().parent.parent
out = Path(sys.argv[1])
out.mkdir(parents=True, exist_ok=True)

paid = json.loads((root / "src" / "data" / "paid.json").read_text(encoding="utf-8"))
for c in paid:
    logo = c.get("logo") or ""
    f = root / "public" / logo.lstrip("/")
    if logo.startswith("/") and f.is_file():
        mime = {".webp": "image/webp", ".png": "image/png", ".svg": "image/svg+xml"}.get(f.suffix, "application/octet-stream")
        c["logo"] = f"data:{mime};base64," + base64.b64encode(f.read_bytes()).decode("ascii")

(out / "extra-channels.json").write_text(json.dumps(paid, ensure_ascii=False), encoding="utf-8")

bat = """@echo off
chcp 65001 >nul
set "DIR=%LOCALAPPDATA%\\com.septeamone.velvetradio"
if not exist "%DIR%" mkdir "%DIR%"
copy /Y "%~dp0extra-channels.json" "%DIR%\\extra-channels.json" >nul
if %errorlevel%==0 (
  echo ГОТОВО. Каналы подключены. Закройте Velvet TV, если она открыта, и запустите её заново.
) else (
  echo НЕ ПОЛУЧИЛОСЬ. Покажите этот текст тому, кто дал вам файл.
)
echo.
pause
"""
(out / "Установить каналы.bat").write_text(bat, encoding="utf-8")
print(f"Каналов в файле: {len(paid)}. Готово: {out}")
