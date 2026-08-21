#!/usr/bin/env bash
# refs.json に書かれた参照リポジトリを取得する。
#
#   GITEA_SERVER=https://gitea.example.com REF_TOKEN=xxxx bash clone_refs.sh
#
# 決めごと:
#   - 1 つ失敗しても止めない。参照資料は「あれば精度が上がる」もので、
#     ジョブが落ちて返信が 1 件も出ないほうが損失が大きい
#   - 取得後に .git を消す。URL にトークンが載るため、残すと AI が Read で読めてしまう
#   - 結果は refs-status.txt に一覧で残す（欠落に気づかないまま回答が続くのを防ぐ）
set -uo pipefail

REFS_FILE="${REFS_FILE:-refs.json}"
SERVER="${GITEA_SERVER:-}"
TOKEN="${REF_TOKEN:-}"
STATUS_FILE="${STATUS_FILE:-refs-status.txt}"

if [ ! -f "$REFS_FILE" ]; then
  echo "参照リポジトリの一覧がありません: $REFS_FILE" >&2
  exit 1
fi
if [ -z "$SERVER" ]; then
  echo "GITEA_SERVER が未設定です（例: https://gitea.example.com）" >&2
  exit 1
fi

# 認証つきの clone URL を組み立てる。トークンは出力しない
build_url() { # build_url <owner/repo>
  local host="${SERVER#*://}" scheme="${SERVER%%://*}"
  host="${host%/}"
  if [ -n "$TOKEN" ]; then
    printf '%s://x-access-token:%s@%s/%s' "$scheme" "$TOKEN" "$host" "$1"
  else
    printf '%s://%s/%s' "$scheme" "$host" "$1"
  fi
}

# git を実行し、出力からトークンを伏せて表示する。終了ステータスは git のものを返す
# （パイプで sed に渡すと、トークンが空のときに sed が落ちる・終了ステータスが紛れる）
run_git() {
  local out rc
  out=$("$@" 2>&1); rc=$?
  if [ -n "$TOKEN" ]; then out=${out//"$TOKEN"/***}; fi
  [ -n "$out" ] && printf '%s\n' "$out"
  return $rc
}

: > "$STATUS_FILE"
MISSING=""
COUNT=$(jq '.repos | length' "$REFS_FILE")

for i in $(seq 0 $((COUNT - 1))); do
  PATH_="$(jq -r ".repos[$i].path" "$REFS_FILE")"
  REPO="$(jq -r ".repos[$i].repo" "$REFS_FILE")"
  REF="$(jq -r ".repos[$i].ref // \"main\"" "$REFS_FILE")"
  SPARSE="$(jq -r ".repos[$i].sparse // [] | join(\"\n\")" "$REFS_FILE")"
  URL="$(build_url "$REPO")"

  echo "--- $REPO ($REF) → $PATH_"
  rm -rf "$PATH_"

  if [ -n "$SPARSE" ]; then
    # 拡張子の否定パターンを使うため cone モードは切る
    if run_git git clone --depth 1 --branch "$REF" --no-checkout "$URL" "$PATH_" \
      && run_git git -C "$PATH_" sparse-checkout set --no-cone $SPARSE \
      && run_git git -C "$PATH_" checkout; then
      RESULT=ok
    else
      RESULT=missing
    fi
  else
    if run_git git clone --depth 1 --branch "$REF" "$URL" "$PATH_"; then
      RESULT=ok
    else
      RESULT=missing
    fi
  fi

  # トークンが .git/config に平文で残るため必ず捨てる
  rm -rf "$PATH_/.git"

  if [ "$RESULT" = ok ] && [ -d "$PATH_" ]; then
    echo "ok      $PATH_ ($REPO)" | tee -a "$STATUS_FILE"
  else
    rm -rf "$PATH_"
    echo "MISSING $PATH_ ($REPO)" | tee -a "$STATUS_FILE"
    MISSING="$MISSING $PATH_"
  fi
done

if [ -n "$MISSING" ]; then
  echo "::warning::参照リポジトリの取得に失敗しました:$MISSING（残りの資料で処理は続けます。リポジトリの改名・削除、または PAT の read 権限を確認してください）"
fi
exit 0
