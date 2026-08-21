#!/usr/bin/env bash
# 起動条件の判定。
#
#   GITHUB_EVENT_PATH=event.json TRIGGER_LABEL=help-AI bash gate.sh
#
# 標準出力に run=true / run=false と判定理由を出し、$GITHUB_OUTPUT があればそこにも書く。
#
# ワークフローの if 式ではなくスクリプトでやる理由:
#   ラベル付与時の payload の形（.label / .changes.added_labels）が Gitea の実装により
#   異なり、式評価器の object filter 対応にも差があるため。payload を直接読むほうが確実で、
#   さらに手元でテストできる（tests/test_gate.sh）。
set -euo pipefail

EVENT_PATH="${1:-${GITHUB_EVENT_PATH:-}}"
TRIGGER_LABEL="${TRIGGER_LABEL:-help-AI}"

if [ -z "$EVENT_PATH" ] || [ ! -f "$EVENT_PATH" ]; then
  echo "run=false reason=イベントファイルが見つかりません"
  [ -n "${GITHUB_OUTPUT:-}" ] && echo "run=false" >> "$GITHUB_OUTPUT"
  exit 0
fi

ACTION=$(jq -r '.action // empty' "$EVENT_PATH")
IS_PR=$(jq -r 'if .issue.pull_request then "1" else "0" end' "$EVENT_PATH")
HAS_LABEL=$(jq -r --arg L "$TRIGGER_LABEL" \
  '[.issue.labels[]?.name] | index($L) | if . == null then "0" else "1" end' "$EVENT_PATH")
# 付与されたラベル。Gitea の payload 差異に両対応し、取得できなければ空にする
ADDED=$(jq -r '[(.label.name // empty), (.changes.added_labels[]?.name // empty)] | .[]' \
  "$EVENT_PATH" 2>/dev/null || true)

RUN=true
REASON=ok

# 判定は if 文で書く。`[ ... ] && VAR=x` は条件不成立時に終了ステータス 1 を残し、
# その行が最終行に来ると set -e で step ごと落ちる（行順に依存する書き方を避ける）
if [ "$IS_PR" = "1" ]; then
  RUN=false; REASON="PR は対象外"
elif [ "$HAS_LABEL" != "1" ]; then
  RUN=false; REASON="${TRIGGER_LABEL} ラベルが付いていない"
elif [ "$ACTION" = "labeled" ] && [ -n "$ADDED" ] && ! printf '%s\n' "$ADDED" | grep -qx "$TRIGGER_LABEL"; then
  # help-AI が付いたままで別のラベルを足したときの再発火を防ぐ
  RUN=false; REASON="今回付与されたのは ${TRIGGER_LABEL} 以外のラベル"
fi

echo "action=$ACTION is_pr=$IS_PR has_label=$HAS_LABEL added=[$(printf '%s' "$ADDED" | tr '\n' ' ')] run=$RUN reason=$REASON"
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  echo "run=$RUN" >> "$GITHUB_OUTPUT"
  echo "reason=$REASON" >> "$GITHUB_OUTPUT"
fi
