#!/usr/bin/env bash
# TaskDeck のテストをまとめて実行する。
#
#   bash tests/run_all.sh
#
# 署名まわり（Python）は依存なしで動く。
# 画面操作（実ブラウザ）は playwright が要るため、入っていなければ飛ばす。
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
FAILED=()

run() {
  local label="$1"; shift
  echo
  echo "=============================================================="
  echo " $label"
  echo "=============================================================="
  if "$@"; then :; else FAILED+=("$label"); fi
}

run "ライセンスの署名と検証" python3 "$HERE/test_license.py"
run "拡張パッケージの署名" python3 "$HERE/test_package.py"
run "発行の控え（台帳）" python3 "$HERE/test_ledger.py"
run "売り始める前の確認" python3 "$HERE/test_preflight.py"

# ⚠ playwright はこのリポジトリの外には無い。無いことは失敗ではない
if node -e "require.resolve('playwright')" > /dev/null 2>&1; then
  run "実ブラウザ: タスク管理の操作" node "$HERE/ui_smoke.mjs"
  run "実ブラウザ: 拡張の署名〜記帳〜取り外し" node "$HERE/ui_extension.mjs"
else
  echo
  echo "  --   実ブラウザのテストは省略（npm i playwright で実行できます）"
fi

echo
echo "=============================================================="
if [ ${#FAILED[@]} -gt 0 ]; then
  echo "失敗したテストがあります:"
  for item in "${FAILED[@]}"; do echo "  - $item"; done
  exit 1
fi
echo "すべてのテストが通りました。"
