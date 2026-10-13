#!/usr/bin/env bash
# Упаковка Velvet TV: установщик (NSIS) и портативный exe в двух вариантах.
#   чистый  — без платных каналов (для друга и для публикации на GitHub)
#   полный  — с локальным файлом платных каналов (только для личного пользования)
# Ключ подписи обновлений лежит вне проекта: ~/.tauri/velvet.key (без пароля).
# Запуск из корня проекта: bash tools/package.sh <папка-вывода>
set -euo pipefail

OUT="${1:?Укажите папку для готовых файлов}"
VERSION="$(grep -m1 '"version"' package.json | sed -E 's/.*"([0-9][^"]*)".*/\1/')"
STASH="$(mktemp -d)"
mkdir -p "$OUT"

export PATH="$PATH:$HOME/.cargo/bin"
export TAURI_SIGNING_PRIVATE_KEY="$HOME/.tauri/velvet.key"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""

restore() {
  [ -f "$STASH/paid.json" ] && mv "$STASH/paid.json" src/data/paid.json
  for f in "$STASH"/p-*; do [ -e "$f" ] && mv "$f" public/logos/; done
  return 0
}
trap restore EXIT

collect() { # $1 — суффикс имени
  local nsis="src-tauri/target/release/bundle/nsis"
  local setup
  setup="$(ls "$nsis"/*_x64-setup.exe | head -1)"
  cp "$setup" "$OUT/VelvetTV_${VERSION}_Setup$1.exe"
  [ -f "$setup.sig" ] && cp "$setup.sig" "$OUT/VelvetTV_${VERSION}_Setup$1.exe.sig"
  cp src-tauri/target/release/velvet-tv.exe "$OUT/VelvetTV_${VERSION}_portable$1.exe"
}

echo "=== Чистая версия (без платных каналов) ==="
[ -f src/data/paid.json ] && mv src/data/paid.json "$STASH/"
for f in public/logos/p-*; do [ -e "$f" ] && mv "$f" "$STASH/"; done
pnpm tauri build
collect ""
# портативная версия обновляет себя сама: ей тоже нужна подпись
env -u TAURI_SIGNING_PRIVATE_KEY -u TAURI_SIGNING_PRIVATE_KEY_PASSWORD pnpm tauri signer sign -f "$HOME/.tauri/velvet.key" -p "" "$OUT/VelvetTV_${VERSION}_portable.exe" > /dev/null
restore

if [ -f src/data/paid.json ]; then
  echo "=== Полная версия (с платными каналами) ==="
  pnpm tauri build
  collect "_full"
fi
echo "=== Готово ==="
ls -la "$OUT"
