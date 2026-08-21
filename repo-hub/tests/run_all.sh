#!/usr/bin/env bash
# 全テストを通す。外部への通信はしない。
#   bash tests/run_all.sh
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$HERE/.."
FAILED=""

run() {
  echo
  echo "=============================================================="
  echo " $1"
  echo "=============================================================="
  shift
  if ! "$@"; then FAILED="$FAILED
  - $1"; fi
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
