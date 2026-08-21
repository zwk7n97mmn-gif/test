#!/usr/bin/env bash
# 起動条件の判定を、実際の payload を模したデータで確かめる。
#   bash tests/test_gate.sh
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
GATE="$HERE/../scripts/gate.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

FAIL=0
check() { # check <期待> <実際> <ラベル>
  if [ "$1" = "$2" ]; then
    echo "  OK   $3"
  else
    echo "  FAIL $3（期待 run=$1 / 実際 run=$2）"
    FAIL=$((FAIL + 1))
  fi
}

run_gate() { # run_gate <payloadファイル> → run の値
  printf '%s' "$(GITHUB_EVENT_PATH="$1" TRIGGER_LABEL=help-AI bash "$GATE" \
    | sed -n 's/.*run=\([a-z]*\).*/\1/p')"
}

payload() { # payload <名前> <JSON>
  printf '%s' "$2" > "$TMP/$1.json"
  echo "$TMP/$1.json"
}

echo "起動条件の判定"

P=$(payload single '{"action":"labeled","label":{"name":"help-AI"},
  "issue":{"number":1,"labels":[{"name":"help-AI"}]}}')
check true "$(run_gate "$P")" "help-AI が単独で付いたら起動する"

P=$(payload multi '{"action":"labeled","changes":{"added_labels":[{"name":"進捗/未着手"},{"name":"help-AI"}]},
  "issue":{"number":2,"labels":[{"name":"進捗/未着手"},{"name":"help-AI"}]}}')
check true "$(run_gate "$P")" "複数同時付与で help-AI が先頭以外でも起動する"

P=$(payload other '{"action":"labeled","label":{"name":"bug"},
  "issue":{"number":3,"labels":[{"name":"help-AI"},{"name":"bug"}]}}')
check false "$(run_gate "$P")" "help-AI が残ったまま別ラベルを足したときは起動しない"

P=$(payload nolabel '{"action":"labeled","label":{"name":"bug"},
  "issue":{"number":4,"labels":[{"name":"bug"}]}}')
check false "$(run_gate "$P")" "help-AI が付いていなければ起動しない"

P=$(payload pr '{"action":"labeled","label":{"name":"help-AI"},
  "issue":{"number":5,"labels":[{"name":"help-AI"}],"pull_request":{"url":"x"}}}')
check false "$(run_gate "$P")" "PR は対象外"

P=$(payload noadded '{"action":"labeled",
  "issue":{"number":6,"labels":[{"name":"help-AI"}]}}')
check true "$(run_gate "$P")" "付与ラベルが payload に無くても、現在のラベルで判定できる"

P=$(payload reopened '{"action":"reopened",
  "issue":{"number":7,"labels":[{"name":"help-AI"}]}}')
check true "$(run_gate "$P")" "labeled 以外のイベントでも、ラベルがあれば起動する"

check false "$(GITHUB_EVENT_PATH=/does/not/exist bash "$GATE" | sed -n 's/.*run=\([a-z]*\).*/\1/p')" \
  "イベントファイルが無いときは起動しない（落とさずに false）"

# $GITHUB_OUTPUT への書き出し
P=$(payload out '{"action":"labeled","label":{"name":"help-AI"},
  "issue":{"number":8,"labels":[{"name":"help-AI"}]}}')
OUT="$TMP/out.txt"; : > "$OUT"
GITHUB_EVENT_PATH="$P" GITHUB_OUTPUT="$OUT" TRIGGER_LABEL=help-AI bash "$GATE" > /dev/null
check "run=true" "$(grep '^run=' "$OUT")" "GITHUB_OUTPUT に run= を書く"

# 別のラベル名でも動く
P=$(payload custom '{"action":"labeled","label":{"name":"ask-ai"},
  "issue":{"number":9,"labels":[{"name":"ask-ai"}]}}')
R=$(GITHUB_EVENT_PATH="$P" TRIGGER_LABEL=ask-ai bash "$GATE" | sed -n 's/.*run=\([a-z]*\).*/\1/p')
check true "$R" "TRIGGER_LABEL を変えればラベル名を差し替えられる"

echo
if [ "$FAIL" -gt 0 ]; then echo "$FAIL 件失敗しました。"; exit 1; fi
echo "すべて通りました。"
