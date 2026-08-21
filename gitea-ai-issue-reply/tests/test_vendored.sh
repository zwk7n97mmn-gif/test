#!/usr/bin/env bash
# 配布元からコピーしてきたツール（vendored）が、元と同じままかを確かめる。
#
# scripts/check_tree.py は check-tree リポジトリが配布元です。
# コピーを手で直すと、配布元との差が静かに広がります。直すのは配布元です。
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
FAIL=0
check() { if [ "$2" = "true" ]; then echo "  OK   $1"; else echo "  FAIL $1"; FAIL=$((FAIL+1)); fi; }

echo "配布元との一致"

VENDORED="$ROOT/scripts/check_tree.py"
UPSTREAM="$ROOT/../check-tree/check_tree.py"

check "配布されたツールがある" "$([ -f "$VENDORED" ] && echo true || echo false)"

if [ -f "$UPSTREAM" ]; then
  if diff -q "$UPSTREAM" "$VENDORED" > /dev/null; then
    check "配布元と同じ内容" "true"
  else
    echo "  FAIL 配布元と同じ内容"
    echo "       違い:"
    diff "$UPSTREAM" "$VENDORED" | head -20 | sed 's/^/       /'
    echo "       直すのは配布元です。コピーし直すには:"
    echo "         cp ../check-tree/check_tree.py scripts/check_tree.py"
    FAIL=$((FAIL + 1))
  fi
else
  echo "  --   配布元が見つからないため比較を省略（このリポジトリ単体で動かしている場合は正常）"
fi

# ツール自体が動くか
python3 "$VENDORED" > /dev/null 2>&1 && R=true || R=false
check "配布されたツールがこのリポジトリで動く" "$R"

echo
if [ "$FAIL" -gt 0 ]; then echo "$FAIL 件失敗しました。"; exit 1; fi
echo "すべて通りました。"
