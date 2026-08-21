#!/usr/bin/env bash
# ツリー照合を対象のリポジトリへ配置する。
#
#   bash install.sh /path/to/your-repo [置き場]
#
# 置き場の既定は tools。scripts など好みに合わせて変えられる。
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
TARGET="${1:-}"
SUBDIR="${2:-tools}"

if [ -z "$TARGET" ]; then
  echo "使い方: bash install.sh <配置先リポジトリのパス> [置き場（既定 tools）]" >&2
  exit 1
fi
[ -d "$TARGET" ] || { echo "配置先がありません: $TARGET" >&2; exit 1; }

mkdir -p "$TARGET/$SUBDIR" "$TARGET/.gitea/workflows"
cp "$HERE/check_tree.py"   "$TARGET/$SUBDIR/check_tree.py"
cp "$HERE/ツリー照合.bat"   "$TARGET/$SUBDIR/ツリー照合.bat"
echo "  配置 $SUBDIR/check_tree.py"
echo "  配置 $SUBDIR/ツリー照合.bat"

if [ ! -f "$TARGET/check-tree.json" ]; then
  cp "$HERE/check-tree.json" "$TARGET/check-tree.json"
  echo "  配置 check-tree.json"
else
  echo "  そのまま check-tree.json（すでにあるため触らない）"
fi

# 置き場を変えた場合はワークフローのパスも合わせる
sed "s|tools/check_tree.py|$SUBDIR/check_tree.py|" "$HERE/workflows/check-tree.yml" \
  > "$TARGET/.gitea/workflows/check-tree.yml"
echo "  配置 .gitea/workflows/check-tree.yml"

cat <<NEXT

配置しました。続けて次を行ってください。

  1. python3 $SUBDIR/check_tree.py --list   で実体の一覧を出す
  2. README に 📦 で始まるツリーを書く
  3. python3 $SUBDIR/check_tree.py          で照合する

まだツリーを書かないリポジトリは、check-tree.json の require_tree を false にしてください。
NEXT
