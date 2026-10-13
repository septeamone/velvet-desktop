#!/usr/bin/env python3
"""Готовит файлы для релиза на GitHub: latest.json (для автообновления) и инструкцию для друга.
Запуск: python tools/make-release-files.py <папка с готовыми файлами>"""
import json, sys, datetime
from pathlib import Path

out = Path(sys.argv[1])
conf = json.loads((Path(__file__).resolve().parent.parent / "src-tauri" / "tauri.conf.json").read_text(encoding="utf-8"))
version = conf["version"]
setup = out / f"VelvetTV_{version}_Setup.exe"
sig = out / f"VelvetTV_{version}_Setup.exe.sig"
if not setup.exists() or not sig.exists():
    sys.exit("Нет установщика или подписи в " + str(out))

latest = {
    "version": version,
    "notes": "Первый выпуск: ТВ с программой и выбором качества, радио на 400+ станций, картинка в картинке, избранное, свой порядок.",
    "pub_date": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "platforms": {
        "windows-x86_64": {
            "signature": sig.read_text(encoding="utf-8").strip(),
            "url": f"https://github.com/septeamone/velvet-desktop/releases/download/v{version}/{setup.name}",
        }
    },
}
(out / "latest.json").write_text(json.dumps(latest, ensure_ascii=False, indent=2), encoding="utf-8")

portable_file = out / f"VelvetTV_{version}_portable.exe"
portable_sig = out / f"VelvetTV_{version}_portable.exe.sig"
if portable_file.exists() and portable_sig.exists():
    (out / "latest-portable.json").write_text(json.dumps({
        "version": version,
        "notes": latest["notes"],
        "pub_date": latest["pub_date"],
        "url": f"https://github.com/septeamone/velvet-desktop/releases/download/v{version}/{portable_file.name}",
        "signature": portable_sig.read_text(encoding="utf-8").strip(),
    }, ensure_ascii=False, indent=2), encoding="utf-8")

size = lambda p: f"{p.stat().st_size / 1024 / 1024:.1f} МБ" if p.exists() else "—"
portable = out / f"VelvetTV_{version}_portable.exe"
(out / "ПРОЧИТАЙ ПЕРЕД УСТАНОВКОЙ.txt").write_text(f"""VELVET TV {version}
Российское ТВ и радио в одном приложении для Windows.

КАК УСТАНОВИТЬ
1. Запусти файл «{setup.name}» ({size(setup)}). Права администратора не нужны.
2. Если Windows пишет «Система Windows защитила ваш компьютер» (синее окно),
   нажми «Подробнее» и затем «Выполнить в любом случае». Так бывает с любыми
   новыми программами без платной цифровой подписи, вирусов в файле нет.
3. После установки на рабочем столе и в меню «Пуск» появится «Velvet TV».

БЕЗ УСТАНОВКИ
Файл «{portable.name}» ({size(portable)}) запускается сразу, откуда угодно (например, с флешки).
Он тоже умеет обновляться: в настройках кнопка «Проверить обновления», программа сама заменит свой файл на новую версию.

ЧТО ВНУТРИ
- ТВ: десятки российских каналов, программа передач, выбор качества, картинка в картинке.
- Радио: 400+ станций из России и 28 стран мира.
- Избранное, поиск, свой порядок (каналы и станции можно перетаскивать мышью).
- Тёмная и светлая тема.

ЕСЛИ ЧТО-ТО НЕ ИГРАЕТ
Каналы идут через сторонние серверы, иногда какой-то не отвечает.
Подожди полминуты или выбери другое качество в кнопке внизу.
""", encoding="utf-8")
# файл «двойной клик»: выкладывает релиз на GitHub от имени владельца репозитория
files = [setup.name, sig.name, portable_file.name, portable_sig.name, "latest.json", "latest-portable.json"]
quoted = " ".join(f'"{f}"' for f in files)
bat = f"""@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Выкладываю Velvet TV {version} на GitHub...
echo.
gh release view v{version} >nul 2>&1
if %errorlevel%==0 (
  gh release upload v{version} {quoted} --clobber
) else (
  gh release create v{version} {quoted} --title "Velvet TV {version}" --notes "{latest['notes']}"
)
echo.
if %errorlevel%==0 (echo ГОТОВО. Теперь у всех, у кого стоит программа, появится кнопка «Обновить».) else (echo НЕ ПОЛУЧИЛОСЬ. Покажи этот текст Клоду.)
echo.
pause
"""
lf = chr(10)
crlf = chr(13) + chr(10)  # у файлов .bat переводы строк Windows
(out / "ВЫЛОЖИТЬ НА GITHUB (двойной клик).bat").write_bytes(bat.replace(crlf, lf).replace(lf, crlf).encode("utf-8"))
print("latest.json, latest-portable.json, инструкция и файл выкладки готовы")
