#!/usr/bin/env bash
# CLI 呼び出しの組み立てを、偽の claude で確かめる（本物は呼ばない）。
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
S="$HERE/../scripts/run_claude.sh"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
FAIL=0
check() { if [ "$2" = "true" ]; then echo "  OK   $1"; else echo "  FAIL $1"; FAIL=$((FAIL+1)); fi; }
has() { case "$1" in *"$2"*) echo true;; *) echo false;; esac; }

echo "Claude CLI の呼び出し"
echo "プロンプト" > "$TMP/prompt.txt"

# --- 想定どおりのフラグを持つ偽 CLI ---
cat > "$TMP/claude_ok" <<'FAKE'
#!/usr/bin/env bash
if [ "${1:-}" = "--help" ]; then
  echo "  --print  --model <m>  --max-turns <n>  --disallowed-tools <list>  --fallback-model <m>"
  exit 0
fi
echo "args: $*" >&2
cat > /dev/null
echo "## ご質問ありがとうございます"
FAKE
chmod +x "$TMP/claude_ok"

OUT=$(CLAUDE_BIN="$TMP/claude_ok" PROMPT_FILE="$TMP/prompt.txt" OUT_FILE="$TMP/reply.md" \
      DRY_RUN=1 bash "$S")
check "モデルを渡す" "$(has "$OUT" -- '--model claude-opus-5')"
check "非対話（--print）で動かす" "$(has "$OUT" -- '--print')"
check "ターン数の上限を渡す" "$(has "$OUT" -- '--max-turns 150')"
check "書き込み系ツールを禁止する" "$(has "$OUT" 'Edit,MultiEdit,Write')"
check "Bash を禁止する" "$(has "$OUT" 'Bash')"
check "代替モデルを渡す" "$(has "$OUT" -- '--fallback-model claude-sonnet-5')"

ERR=$(CLAUDE_BIN="$TMP/claude_ok" PROMPT_FILE="$TMP/prompt.txt" OUT_FILE="$TMP/reply.md" \
      bash "$S" 2>&1)
check "実行すると返信ファイルができる" "$([ -s "$TMP/reply.md" ] && echo true || echo false)"
check "生成した旨を表示する" "$(has "$ERR" '返信を生成しました')"

# --- フラグ名が違う CLI は起動前に落とす ---
cat > "$TMP/claude_old" <<'FAKE'
#!/usr/bin/env bash
[ "${1:-}" = "--help" ] && { echo "  --print  --model <m>  --allowedTools <list>"; exit 0; }
echo "本文"
FAKE
chmod +x "$TMP/claude_old"
ERR=$(CLAUDE_BIN="$TMP/claude_old" PROMPT_FILE="$TMP/prompt.txt" OUT_FILE="$TMP/x.md" bash "$S" 2>&1); RC=$?
check "想定と違うフラグ名なら起動せずに落ちる" "$([ "$RC" = "2" ] && echo true || echo false)"
check "どのフラグが無いかを出す" "$(has "$ERR" -- '--max-turns')"

# --- 空の返信を失敗として扱う ---
cat > "$TMP/claude_empty" <<'FAKE'
#!/usr/bin/env bash
[ "${1:-}" = "--help" ] && { echo "  --print --model --max-turns --disallowed-tools"; exit 0; }
cat > /dev/null
FAKE
chmod +x "$TMP/claude_empty"
ERR=$(CLAUDE_BIN="$TMP/claude_empty" PROMPT_FILE="$TMP/prompt.txt" OUT_FILE="$TMP/empty.md" bash "$S" 2>&1); RC=$?
check "返信が空なら失敗にする" "$([ "$RC" = "3" ] && echo true || echo false)"

# --- 異常終了をそのまま伝える ---
cat > "$TMP/claude_ng" <<'FAKE'
#!/usr/bin/env bash
[ "${1:-}" = "--help" ] && { echo "  --print --model --max-turns --disallowed-tools"; exit 0; }
cat > /dev/null; echo "boom" >&2; exit 7
FAKE
chmod +x "$TMP/claude_ng"
ERR=$(CLAUDE_BIN="$TMP/claude_ng" PROMPT_FILE="$TMP/prompt.txt" OUT_FILE="$TMP/ng.md" bash "$S" 2>&1); RC=$?
check "CLI の異常終了を伝える" "$([ "$RC" = "7" ] && [ "$(has "$ERR" '異常終了')" = true ] && echo true || echo false)"

echo
if [ "$FAIL" -gt 0 ]; then echo "$FAIL 件失敗しました。"; exit 1; fi
echo "すべて通りました。"
