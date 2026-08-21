#!/usr/bin/env bash
# Claude Code CLI を非対話で実行し、返信本文を出力する。
#
#   PROMPT_FILE=prompt.txt OUT_FILE=reply.md bash run_claude.sh
#
# CLI のフラグ名は版によって変わることがある（--allowedTools と --allowed-tools など）。
# 実行前に `claude --help` と突き合わせ、合わなければ**起動せずに落とす**。
# 途中まで動いて失敗するより、理由がはっきり出るほうが直しやすい。
set -uo pipefail

CLAUDE_BIN="${CLAUDE_BIN:-claude}"
PROMPT_FILE="${PROMPT_FILE:-prompt.txt}"
OUT_FILE="${OUT_FILE:-reply.md}"
MODEL="${MODEL:-claude-opus-5}"
FALLBACK_MODEL="${FALLBACK_MODEL:-claude-sonnet-5}"
MAX_TURNS="${MAX_TURNS:-150}"
TIMEOUT_MINUTES="${TIMEOUT_MINUTES:-60}"
# 返信に不要なツールは落とす。イシュー本文は外部入力なので、スキルの指示だけに頼らない
DISALLOWED_TOOLS="${DISALLOWED_TOOLS:-Edit,MultiEdit,Write,NotebookEdit,Bash,WebFetch,WebSearch}"
DRY_RUN="${DRY_RUN:-0}"
SKIP_FLAG_CHECK="${SKIP_FLAG_CHECK:-0}"

[ -f "$PROMPT_FILE" ] || { echo "プロンプトがありません: $PROMPT_FILE" >&2; exit 1; }

# 使うフラグが CLI に存在するか確かめる
FLAGS=(--print --model --max-turns --disallowed-tools)
if [ "$SKIP_FLAG_CHECK" != "1" ]; then
  HELP="$("$CLAUDE_BIN" --help 2>&1 || true)"
  MISSING=""
  for f in "${FLAGS[@]}"; do
    case "$HELP" in *"$f"*) ;; *) MISSING="$MISSING $f";; esac
  done
  if [ -n "$MISSING" ]; then
    {
      echo "Claude Code CLI に想定したフラグがありません:$MISSING"
      echo "インストール済みの CLI の版を確認し、run_claude.sh の FLAGS と呼び出しを合わせてください。"
      echo "（$CLAUDE_BIN --help の出力で名前を確認できます）"
    } >&2
    exit 2
  fi
fi

ARGS=(
  --print
  --model "$MODEL"
  --max-turns "$MAX_TURNS"
  --disallowed-tools "$DISALLOWED_TOOLS"
)
# 過負荷時の代替モデル。品質を落としてよいという意味ではなく、
# 「失敗して何も出ない」より「代替で返す」ほうがましな場面のための保険
if [ -n "$FALLBACK_MODEL" ]; then
  case "${HELP:-}" in
    *--fallback-model*) ARGS+=(--fallback-model "$FALLBACK_MODEL") ;;
    *) [ "$SKIP_FLAG_CHECK" = "1" ] && ARGS+=(--fallback-model "$FALLBACK_MODEL") ;;
  esac
fi

if [ "$DRY_RUN" = "1" ]; then
  printf '%s\n' "DRY_RUN $CLAUDE_BIN ${ARGS[*]} < $PROMPT_FILE > $OUT_FILE"
  exit 0
fi

timeout "${TIMEOUT_MINUTES}m" "$CLAUDE_BIN" "${ARGS[@]}" < "$PROMPT_FILE" > "$OUT_FILE"
RC=$?

if [ "$RC" -eq 124 ]; then
  echo "${TIMEOUT_MINUTES} 分で打ち切りました" >&2
  exit 124
fi
if [ "$RC" -ne 0 ]; then
  echo "Claude Code CLI が異常終了しました (exit $RC)" >&2
  exit "$RC"
fi
if [ ! -s "$OUT_FILE" ]; then
  echo "返信が空でした" >&2
  exit 3
fi
echo "返信を生成しました: $OUT_FILE ($(wc -c < "$OUT_FILE") バイト)"
