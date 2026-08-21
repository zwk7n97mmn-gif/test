#!/usr/bin/env bash
# 全テストを通す。外部への通信はしない（偽の git / claude / DRY_RUN で確かめる）。
#   bash tests/run_all.sh
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$HERE/.."
FAILED=""

run() {
  local label="$1"; shift
  echo
  echo "=============================================================="
  echo " $label"
  echo "=============================================================="
  # ⚠ shift のあとに $1 を使うと、失敗一覧に "bash" と出てしまう
  if ! "$@"; then FAILED="$FAILED
  - $label"; fi
}

run "起動条件の判定"            bash "$HERE/test_gate.sh"
run "参照リポジトリの取得"      bash "$HERE/test_clone_refs.sh"
run "プロンプトの組み立て"      bash "$HERE/test_build_prompt.sh"
run "Gitea API の呼び出し"      bash "$HERE/test_gitea_api.sh"
run "Claude CLI の呼び出し"     bash "$HERE/test_run_claude.sh"
run "一覧の食い違い検査"        python3 "$HERE/test_check_sync.py"
run "配布元との一致"            bash "$HERE/test_vendored.sh"
run "配置ファイルの整合"        bash "$HERE/test_layout.sh"

echo
echo "=============================================================="
if [ -n "$FAILED" ]; then
  echo "失敗したテストがあります:$FAILED"
  exit 1
fi
echo "すべてのテストが通りました。"
