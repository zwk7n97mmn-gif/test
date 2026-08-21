#!/usr/bin/env bash
# 配置したままの状態で、検査が通ることを確かめる。
#
# 入れた直後に大量の指摘が出る道具は使われなくなる。
# 雛形は「そのままで通り、書き足すほど中身が増える」状態を保つ。
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
FAIL=0
check() { if [ "$2" = "true" ]; then echo "  OK   $1"; else echo "  FAIL $1"; FAIL=$((FAIL+1)); fi; }

echo "配置と初回の検査"

bash "$ROOT/scripts/install.sh" "$TMP" > /dev/null 2>&1
check "配置できる" "$([ -f "$TMP/scripts/wiki_lint.py" ] && echo true || echo false)"
check "決まりごとを配置する" "$([ -f "$TMP/CLAUDE.md" ] && echo true || echo false)"
check "目次の雛形を配置する" "$([ -f "$TMP/README.md" ] && echo true || echo false)"
check "ページの雛形を配置する" "$([ -f "$TMP/wikiの編集方法/テンプレート/汎用ページ.md" ] && echo true || echo false)"
check "人向けの書き方ページを配置する" "$([ -f "$TMP/wikiの編集方法/ページの書き方.md" ] && echo true || echo false)"
check "CI の雛形を配置する" "$([ -f "$TMP/.gitea/workflows/wiki-lint.yml" ] && echo true || echo false)"
check "画像の置き場を作る" "$([ -d "$TMP/_image/_HOME" ] && echo true || echo false)"

( cd "$TMP" && python3 scripts/wiki_lint.py > /dev/null 2>&1 ) && R=true || R=false
check "配置したままで検査が通る" "$R"

# 既存ファイルを守る
echo "私が書いた目次" > "$TMP/README.md"
bash "$ROOT/scripts/install.sh" "$TMP" > /dev/null 2>&1
check "すでにある README を上書きしない" \
  "$([ "$(cat "$TMP/README.md")" = "私が書いた目次" ] && echo true || echo false)"

# 検査そのものは更新される（配布物のため）
echo "# 古い" > "$TMP/scripts/wiki_lint.py"
bash "$ROOT/scripts/install.sh" "$TMP" > /dev/null 2>&1
check "検査は最新に入れ替える" \
  "$([ "$(head -c 20 "$TMP/scripts/wiki_lint.py")" != "# 古い" ] && echo true || echo false)"

echo
if [ "$FAIL" -gt 0 ]; then echo "$FAIL 件失敗しました。"; exit 1; fi
echo "すべて通りました。"
