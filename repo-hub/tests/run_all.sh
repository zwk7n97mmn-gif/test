#!/usr/bin/env bash
# 全テストを通す。外部への通信はしない。
#   bash tests/run_all.sh
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$HERE/.."
FAILED=""

run() {
  local label="$1"; shift
  echo
  echo "=============================================================="
  echo " $label"
  echo "=============================================================="
  # ⚠ shift のあとに $1 を使うと、失敗一覧に "bash" と出てしまう
  if ! "$@"; then FAILED="$FAILED
  - $label"; fi
}

run "一覧とページの照合"    python3 "$HERE/test_check_repos.py"
run "リンク切れ検査"        python3 "$HERE/test_check_links.py"

echo
echo "=============================================================="
echo " 本番のページを検査する"
echo "=============================================================="
python3 "$ROOT/scripts/check_repos.py" || FAILED="$FAILED
  - 本番の一覧照合"
python3 "$ROOT/scripts/check_links.py" || FAILED="$FAILED
  - 本番のリンク検査"

echo
echo "=============================================================="
if [ -n "$FAILED" ]; then
  echo "失敗したテストがあります:$FAILED"
  exit 1
fi
echo "すべてのテストが通りました。"
