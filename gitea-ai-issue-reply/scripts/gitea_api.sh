#!/usr/bin/env bash
# Gitea のイシューコメント・ラベル操作。
#
#   GITEA_API=https://gitea.example.com/api/v1/repos/org/repo BOT_TOKEN=xxx \
#     bash gitea_api.sh create-comment 42 body.md
#
# サブコマンド:
#   comments        <issue>                 コメント一覧を JSON で出す
#   create-comment  <issue> <本文ファイル>   コメントを作り、その id を出す
#   update-comment  <id>    <本文ファイル>   コメントを書き換える
#   remove-label    <issue> <ラベル名>       ラベルを外す
#
# DRY_RUN=1 を付けると、送信せずに要求内容だけを表示する（手元での確認用）。
set -euo pipefail

API="${GITEA_API:-}"
TOKEN="${BOT_TOKEN:-}"
DRY_RUN="${DRY_RUN:-0}"

[ -n "$API" ] || { echo "GITEA_API が未設定です" >&2; exit 1; }
API="${API%/}"

request() { # request <METHOD> <URL> [本文JSONファイル]
  local method="$1" url="$2" data="${3:-}"
  if [ "$DRY_RUN" = "1" ]; then
    echo "DRY_RUN ${method} ${url}"
    [ -n "$data" ] && { echo "--- body ---"; cat "$data"; echo; }
    return 0
  fi
  if [ -n "$data" ]; then
    curl -sS -X "$method" -H "Authorization: token ${TOKEN}" \
      -H 'Content-Type: application/json' --data-binary "@$data" "$url"
  else
    curl -sS -X "$method" -H "Authorization: token ${TOKEN}" "$url"
  fi
}

# 本文ファイル → {"body": "..."} の JSON（改行・引用符をそのまま安全に入れる）
body_json() { # body_json <本文ファイル> <出力先>
  jq -n --rawfile b "$1" '{body: $b}' > "$2"
}

CMD="${1:-}"; shift || true
case "$CMD" in
  comments)
    request GET "${API}/issues/${1}/comments"
    ;;
  create-comment)
    TMP=$(mktemp); body_json "$2" "$TMP"
    OUT=$(request POST "${API}/issues/${1}/comments" "$TMP")
    rm -f "$TMP"
    if [ "$DRY_RUN" = "1" ]; then echo "$OUT"; echo "id=999999"; else
      printf '%s' "$OUT" | jq -r '.id // empty'
    fi
    ;;
  update-comment)
    TMP=$(mktemp); body_json "$2" "$TMP"
    # DRY_RUN のときは要求内容を見せる。実行時は応答（コメント全体の JSON）を捨てる
    if [ "$DRY_RUN" = "1" ]; then
      request PATCH "${API}/issues/comments/${1}" "$TMP"
    else
      request PATCH "${API}/issues/comments/${1}" "$TMP" > /dev/null
    fi
    rm -f "$TMP"
    ;;
  remove-label)
    # DELETE はラベル ID 指定が必要なので、名前から引く
    if [ "$DRY_RUN" = "1" ]; then
      echo "DRY_RUN GET ${API}/issues/${1}/labels"
      echo "DRY_RUN DELETE ${API}/issues/${1}/labels/<${2} の id>"
      exit 0
    fi
    ID=$(request GET "${API}/issues/${1}/labels" | jq -r --arg n "$2" '.[] | select(.name==$n) | .id')
    if [ -n "$ID" ] && [ "$ID" != "null" ]; then
      request DELETE "${API}/issues/${1}/labels/${ID}" > /dev/null
      echo "ラベル ${2} を外しました"
    else
      echo "ラベル ${2} は付いていません"
    fi
    ;;
  *)
    echo "使い方: $0 {comments|create-comment|update-comment|remove-label} ..." >&2
    exit 1
    ;;
esac
