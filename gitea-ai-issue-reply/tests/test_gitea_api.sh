#!/usr/bin/env bash
# Gitea API 呼び出しの組み立てを DRY_RUN で確かめる（通信はしない）。
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
S="$HERE/../scripts/gitea_api.sh"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
FAIL=0
check() { if [ "$2" = "true" ]; then echo "  OK   $1"; else echo "  FAIL $1"; FAIL=$((FAIL+1)); fi; }
has() { case "$1" in *"$2"*) echo true;; *) echo false;; esac; }

export GITEA_API=https://gitea.example.com/api/v1/repos/org/repo
export BOT_TOKEN=SECRETTOKEN
export DRY_RUN=1

echo "Gitea API の呼び出し"

printf '## 返信\n\n"引用" と改行を含む本文\\n\n' > "$TMP/body.md"

OUT=$(bash "$S" create-comment 42 "$TMP/body.md")
check "コメント作成は POST /issues/<番号>/comments" "$(has "$OUT" 'DRY_RUN POST https://gitea.example.com/api/v1/repos/org/repo/issues/42/comments')"
check "本文を JSON の body に入れる" "$(has "$OUT" '"body"')"
check "改行を \\n に符号化する" "$(has "$OUT" '\n')"
check "引用符を壊さない" "$(has "$OUT" '\"引用\"')"
check "トークンを表示しない" "$([ "$(has "$OUT" SECRETTOKEN)" = false ] && echo true || echo false)"

OUT=$(bash "$S" update-comment 777 "$TMP/body.md")
check "コメント更新は PATCH /issues/comments/<id>" "$(has "$OUT" 'DRY_RUN PATCH https://gitea.example.com/api/v1/repos/org/repo/issues/comments/777')"

OUT=$(bash "$S" comments 42)
check "コメント取得は GET" "$(has "$OUT" 'DRY_RUN GET https://gitea.example.com/api/v1/repos/org/repo/issues/42/comments')"

OUT=$(bash "$S" remove-label 42 help-AI)
check "ラベル削除は id を引いてから DELETE" "$(has "$OUT" 'DELETE https://gitea.example.com/api/v1/repos/org/repo/issues/42/labels/<help-AI の id>')"

OUT=$(GITEA_API=https://gitea.example.com/api/v1/repos/org/repo/ bash "$S" comments 42)
check "末尾のスラッシュがあっても URL が壊れない" "$(has "$OUT" 'repos/org/repo/issues/42/comments')"

OUT=$(bash "$S" 2>&1); RC=$?
check "サブコマンド無しなら使い方を出して失敗する" "$([ "$RC" != "0" ] && [ "$(has "$OUT" '使い方')" = true ] && echo true || echo false)"

echo
if [ "$FAIL" -gt 0 ]; then echo "$FAIL 件失敗しました。"; exit 1; fi
echo "すべて通りました。"
