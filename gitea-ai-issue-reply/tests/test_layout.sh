#!/usr/bin/env bash
# キットの中身とワークフローの記述が食い違っていないかを確かめる。
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
FAIL=0
check() { if [ "$2" = "true" ]; then echo "  OK   $1"; else echo "  FAIL $1"; FAIL=$((FAIL+1)); fi; }

echo "配置ファイルの整合"

# ワークフローが呼ぶスクリプトが、すべて同梱されているか
MISSING=""
for s in $(grep -o '\.gitea/scripts/[a-z_]*\.\(sh\|py\)' "$ROOT/workflows/ai-issue-reply.yml" | sort -u); do
  name="${s##*/}"
  [ -f "$ROOT/scripts/$name" ] || MISSING="$MISSING $name"
done
check "ワークフローが呼ぶスクリプトがすべてある${MISSING:+（不足:$MISSING）}" "$([ -z "$MISSING" ] && echo true || echo false)"

# install.sh が配置するファイルが、すべて存在するか
bash "$ROOT/scripts/install.sh" "$TMP" > /dev/null 2>&1
check "install.sh が配置先を作れる" "$([ -f "$TMP/.gitea/workflows/ai-issue-reply.yml" ] && echo true || echo false)"
check "スキル定義を配置する" "$([ -f "$TMP/.claude/skills/issue-ai-reply/SKILL.md" ] && echo true || echo false)"
check "スクリプト一式を配置する" "$([ -f "$TMP/.gitea/scripts/gate.sh" ] && [ -f "$TMP/.gitea/scripts/run_claude.sh" ] && echo true || echo false)"
check "refs.json を配置する" "$([ -f "$TMP/refs.json" ] && echo true || echo false)"
check ".gitattributes を配置する" "$([ -f "$TMP/.gitattributes" ] && echo true || echo false)"

# 2 回目は既存ファイルがあるので止まる
OUT=$(bash "$ROOT/scripts/install.sh" "$TMP" 2>&1); RC=$?
check "既存ファイルがあれば上書きせずに止まる" "$([ "$RC" != "0" ] && echo true || echo false)"
OUT=$(bash "$ROOT/scripts/install.sh" "$TMP" --force 2>&1); RC=$?
check "--force なら上書きする" "$([ "$RC" = "0" ] && echo true || echo false)"

# 配置後のスクリプトが動く（配置先から見た相対パスで壊れていないか）
printf '{"action":"labeled","label":{"name":"help-AI"},"issue":{"number":1,"labels":[{"name":"help-AI"}]}}' > "$TMP/ev.json"
R=$( cd "$TMP" && GITHUB_EVENT_PATH=ev.json bash .gitea/scripts/gate.sh | sed -n 's/.*run=\([a-z]*\).*/\1/p' )
check "配置先でも起動条件の判定が動く" "$([ "$R" = "true" ] && echo true || echo false)"

# YAML として妥当か
python3 - "$ROOT" <<'PY' && Y=true || Y=false
import sys, yaml, pathlib
root = pathlib.Path(sys.argv[1])
for f in [root/"workflows/ai-issue-reply.yml", root/"issue-templates/ask_ai.yaml"]:
    yaml.safe_load(f.read_text(encoding="utf-8"))
PY
check "ワークフローとテンプレートが YAML として読める" "$Y"

# 参照一覧の食い違い
python3 "$ROOT/scripts/check_sync.py" > /dev/null && S=true || S=false
check "refs.json / SKILL.md / 運用仕様.md の一覧が一致している" "$S"

echo
if [ "$FAIL" -gt 0 ]; then echo "$FAIL 件失敗しました。"; exit 1; fi
echo "すべて通りました。"
