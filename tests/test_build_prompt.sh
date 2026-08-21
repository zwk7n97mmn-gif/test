#!/usr/bin/env bash
# プロンプト組み立ての確認。
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
S="$HERE/../scripts/build_prompt.sh"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
FAIL=0
check() { if [ "$2" = "true" ]; then echo "  OK   $1"; else echo "  FAIL $1"; FAIL=$((FAIL+1)); fi; }
has() { case "$1" in *"$2"*) echo true;; *) echo false;; esac; }
# 説明文中の <comments> と、実際のブロック開始行を区別する
has_block() { printf '%s\n' "$1" | grep -qx '<comments>' && echo true || echo false; }

echo "プロンプトの組み立て"
printf 'ok      src (org/app)\nMISSING wiki (org/wiki)\n' > "$TMP/refs-status.txt"

OUT=$(EVENT_PATH="$HERE/fixtures/event.json" STATUS_FILE="$TMP/refs-status.txt" bash "$S")
check "タイトルを含む" "$(has "$OUT" '検索条件の初期値をどこで決めているか')"
check "本文を含む" "$(has "$OUT" '検索条件の初期値が空になる件')"
check "イシュー番号を含む" "$(has "$OUT" '<number>42</number>')"
check "ラベルを含む" "$(has "$OUT" 'help-AI, 質問')"
check "外部入力として扱う注意を含む" "$(has "$OUT" '外部からの入力')"
check "返信本文だけを出す指示を含む" "$(has "$OUT" '返信本文だけを出力')"
check "参照リポジトリの取得結果を含む" "$(has "$OUT" 'MISSING wiki')"
check "コメントが無ければ <comments> ブロックを出さない" "$([ "$(has_block "$OUT")" = false ] && echo true || echo false)"

OUT=$(EVENT_PATH="$HERE/fixtures/event.json" COMMENTS_FILE="$HERE/fixtures/comments.json" \
      BOT_LOGIN=ai-bot STATUS_FILE="$TMP/refs-status.txt" bash "$S")
check "コメントがあれば <comments> ブロックを出す" "$(has_block "$OUT")"
check "自分の過去返信に by_ai=true を付ける" "$(has "$OUT" 'author="ai-bot" at="2026-08-21T01:00:00Z" by_ai="true"')"
check "利用者のコメントは by_ai=false" "$(has "$OUT" 'author="hanako" at="2026-08-21T02:00:00Z" by_ai="false"')"
check "追加質問の本文を含む" "$(has "$OUT" '権限による出し分けも知りたい')"
check "再返信の扱いを説明している" "$(has "$OUT" '追加の要件として扱ってください')"

printf '[]' > "$TMP/empty.json"
OUT=$(EVENT_PATH="$HERE/fixtures/event.json" COMMENTS_FILE="$TMP/empty.json" bash "$S")
check "コメントが 0 件なら <comments> ブロックを出さない" "$([ "$(has_block "$OUT")" = false ] && echo true || echo false)"

echo
if [ "$FAIL" -gt 0 ]; then echo "$FAIL 件失敗しました。"; exit 1; fi
echo "すべて通りました。"
