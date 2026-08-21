#!/usr/bin/env bash
# 契約プランの利用上限に達したことを伝える文面を作る。
#
#   bash usage_limit_message.sh <エポック秒>      # 引数から
#   USAGE_LIMIT_FILE=usage-limit.txt bash usage_limit_message.sh
#
# ⚠ TZ=Asia/Tokyo は使わない。ランナーに tzdata が無いと黙って無視され、
#    UTC の時刻を JST と書いてしまう。UTC 固定で +9 時間して組み立てる。
set -uo pipefail

USAGE_LIMIT_FILE="${USAGE_LIMIT_FILE:-usage-limit.txt}"
TRIGGER_LABEL="${TRIGGER_LABEL:-help-AI}"
EPOCH="${1:-}"
[ -z "$EPOCH" ] && [ -f "$USAGE_LIMIT_FILE" ] && EPOCH="$(cat "$USAGE_LIMIT_FILE")"

echo "**契約プランの利用上限に達したため、返信を生成できませんでした。**"
echo

case "$EPOCH" in
  ''|*[!0-9]*)
    # 時刻が読み取れないときは推測で埋めない
    echo "- 追加の請求は発生していません（枠の範囲で動く設定のため）"
    echo "- 再実行: 枠が回復してから \`${TRIGGER_LABEL}\` ラベルを付け直してください"
    ;;
  *)
    RESET=$(date -u -d "@$(( EPOCH + 32400 ))" '+%Y-%m-%d %H:%M' 2>/dev/null || echo "")
    NOW=$(date +%s)
    WAIT=$(( EPOCH - NOW ))
    [ "$WAIT" -lt 0 ] && WAIT=0
    if [ -n "$RESET" ]; then
      echo "- リセット: **${RESET} JST**（あと約 $(( WAIT / 3600 )) 時間 $(( WAIT % 3600 / 60 )) 分）"
    fi
    echo "- 追加の請求は発生していません（枠の範囲で動く設定のため）"
    echo "- 再実行: リセット後に \`${TRIGGER_LABEL}\` ラベルを付け直してください"
    ;;
esac
