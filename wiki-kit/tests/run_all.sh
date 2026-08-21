#!/usr/bin/env bash
# 全テストを通す。外部への通信はしない。
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$HERE/.."
FAILED=""

echo "=============================================================="
echo " 決まりごと検査の動き"
echo "=============================================================="
python3 "$HERE/test_wiki_lint.py" || FAILED="$FAILED
  - 動きのテスト"

echo
echo "=============================================================="
echo " 配置と初回の検査"
echo "=============================================================="
bash "$HERE/test_install.sh" || FAILED="$FAILED
  - 配置のテスト"

echo
echo "=============================================================="
echo " このキット自身を検査する"
echo "=============================================================="
python3 "$ROOT/scripts/wiki_lint.py" --root "$ROOT" --only links,wrapping,images \
  || FAILED="$FAILED
  - キット自身の検査"

echo
echo "=============================================================="
if [ -n "$FAILED" ]; then
  echo "失敗したテストがあります:$FAILED"
  exit 1
fi
echo "すべてのテストが通りました。"
