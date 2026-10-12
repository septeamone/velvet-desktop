#!/usr/bin/env python3
"""Собирает компактную программу передач для каналов приложения.

Скачивает большие открытые файлы XMLTV (epg.one, iptvx.one), оставляет только нужные каналы
на окно [сейчас-3ч, сейчас+48ч] и пишет data/epg.json. Запускается по расписанию в GitHub Actions
(см. .github/workflows/epg.yml), вручную: python tools/build-epg.py
"""
import gzip, json, re, sys, time, urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parent.parent
SOURCES = ["http://cdn.epg.one/epg2.xml.gz", "https://iptvx.one/epg/epg.xml.gz"]
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130 Safari/537.36"}

aliases = json.loads((ROOT / "tools" / "epg-map.json").read_text(encoding="utf-8"))
alias_to_ours = {}
for ours, names in aliases.items():
    for n in names:
        alias_to_ours.setdefault(n.lower(), []).append(ours)

now = datetime.now(timezone.utc)
lo, hi = now - timedelta(hours=3), now + timedelta(hours=48)


def ts(s):
    m = re.match(r"(\d{14})\s*([+-]\d{4})?", s or "")
    if not m:
        return None
    dt = datetime.strptime(m.group(1), "%Y%m%d%H%M%S")
    off = m.group(2) or "+0000"
    sign = 1 if off[0] == "+" else -1
    tz = timezone(sign * timedelta(hours=int(off[1:3]), minutes=int(off[3:5])))
    return int(dt.replace(tzinfo=tz).timestamp())


def read_source(url):
    """Возвращает {наш_id: {id_в_xmltv: [программы]}}; при обрыве скачивания отдаёт то, что успели прочитать."""
    cand = {}      # id в xmltv -> наши id
    found = {}     # наш id -> id в xmltv -> список
    t0 = time.time()
    try:
        req = urllib.request.Request(url, headers=UA)
        with urllib.request.urlopen(req, timeout=60) as resp:
            gz = gzip.GzipFile(fileobj=resp)
            for _ev, el in ET.iterparse(gz, events=("end",)):
                if el.tag == "channel":
                    cid = el.get("id")
                    for dn in el.findall("display-name"):
                        name = (dn.text or "").strip().lower()
                        if name in alias_to_ours:
                            cand.setdefault(cid, set()).update(alias_to_ours[name])
                    el.clear()
                elif el.tag == "programme":
                    cid = el.get("channel")
                    if cid in cand:
                        s, e = ts(el.get("start")), ts(el.get("stop"))
                        if s and e and e > lo.timestamp() and s < hi.timestamp():
                            title = (el.findtext("title") or "").strip()
                            if title:
                                desc = (el.findtext("desc") or "").strip()[:160]
                                age = (el.findtext("rating/value") or "").strip()
                                for ours in cand[cid]:
                                    found.setdefault(ours, {}).setdefault(cid, []).append([s, e, title, age, desc])
                    el.clear()
    except Exception as exc:  # обрыв связи: берём частичные данные
        print(f"  ! {url}: {type(exc).__name__}: {exc}", file=sys.stderr)
    print(f"  {url}: {sum(len(v) for d in found.values() for v in d.values())} программ за {time.time()-t0:.0f} с")
    return found


best = {}
for url in SOURCES:
    print("Источник", url)
    for ours, by_id in read_source(url).items():
        for cid, progs in by_id.items():
            if len(progs) > len(best.get(ours, [])):
                best[ours] = progs

out = {}
for ours, progs in best.items():
    uniq = {p[0]: p for p in progs}
    out[ours] = [uniq[k] for k in sorted(uniq)]

(ROOT / "data").mkdir(exist_ok=True)
payload = {"generated": int(now.timestamp()), "channels": out}
(ROOT / "data" / "epg.json").write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
missing = sorted(set(aliases) - set(out))
print(f"Готово: {len(out)} каналов, {sum(len(v) for v in out.values())} программ, {(ROOT/'data'/'epg.json').stat().st_size//1024} КБ")
print("Нет программы:", ", ".join(missing) if missing else "нет таких")
