#!/usr/bin/env bash
# wiki の雛形と検査を、対象のリポジトリへ配置する。
#
#   bash scripts/install.sh /path/to/your-wiki
#
# すでにあるファイル（README.md / CLAUDE.md など）は上書きしない。
set -euo pipefail

KIT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="${1:-}"

if [ -z "$TARGET" ]; then
  echo "使い方: bash scripts/install.sh <配置先の wiki リポジトリ>" >&2
  exit 1
fi
[ -d "$TARGET" ] || { echo "配置先がありません: $TARGET" >&2; exit 1; }

place() { # place <配置先の相対パス> <キット内のパス> <上書きするか>
  local dest="$TARGET/$1" src="$KIT/$2" overwrite="${3:-no}"
  mkdir -p "$(dirname "$dest")"
  if [ -e "$dest" ] && [ "$overwrite" != "yes" ]; then
    echo "  そのまま $1（すでにあるため触らない）"
    return
  fi
  cp "$src" "$dest"
  echo "  配置 $1"
}

# 検査は常に最新へ更新する（配布物のため）
place "scripts/wiki_lint.py" "scripts/wiki_lint.py" yes
place ".gitea/workflows/wiki-lint.yml" "workflows/wiki-lint.yml" yes

# 各リポジトリで育てるものは、あれば触らない
place "wiki-lint.json" "wiki-lint.json"
place "CLAUDE.md" "templates/CLAUDE.md"
place "README.md" "templates/README.md"
for name in 汎用ページ 手順ページ 機能説明ページ コンポーネント説明ページ; do
  place "templates/$name.md" "templates/$name.md"
done

mkdir -p "$TARGET/_image/_HOME"

cat <<'NEXT'

配置しました。続けて次を行ってください。

  1. CLAUDE.md の〔　〕を、このwikiの内容に置き換える
  2. README.md の目次を、実際に作るページの構成に書き換える
  3. python3 scripts/wiki_lint.py で決まりごとを確かめる

ページを書くときは templates/ からコピーしてください。
NEXT
