#!/usr/bin/env bash
# このキットを、イシューを立てるリポジトリへ配置する。
#
#   bash scripts/install.sh /path/to/your-repo
#
# 上書きする前に、既存ファイルがあれば知らせて中断する（--force で上書き）。
set -euo pipefail

KIT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="${1:-}"
FORCE="${2:-}"

if [ -z "$TARGET" ]; then
  echo "使い方: bash scripts/install.sh <配置先リポジトリのパス> [--force]" >&2
  exit 1
fi
[ -d "$TARGET" ] || { echo "配置先がありません: $TARGET" >&2; exit 1; }

FILES=(
  ".gitea/workflows/ai-issue-reply.yml|workflows/ai-issue-reply.yml"
  ".gitea/ISSUE_TEMPLATE/ask_ai.yaml|issue-templates/ask_ai.yaml"
  ".claude/skills/issue-ai-reply/SKILL.md|skills/issue-ai-reply/SKILL.md"
  "refs.json|refs.json"
  ".gitattributes|.gitattributes"
)
SCRIPTS=(gate.sh clone_refs.sh build_prompt.sh run_claude.sh gitea_api.sh check_sync.py)

# 既存ファイルの確認
EXISTING=""
for pair in "${FILES[@]}"; do
  dest="${pair%%|*}"
  [ -e "$TARGET/$dest" ] && EXISTING="$EXISTING $dest"
done
for s in "${SCRIPTS[@]}"; do
  [ -e "$TARGET/.gitea/scripts/$s" ] && EXISTING="$EXISTING .gitea/scripts/$s"
done
if [ -n "$EXISTING" ] && [ "$FORCE" != "--force" ]; then
  echo "配置先にすでにファイルがあります:$EXISTING" >&2
  echo "上書きしてよければ --force を付けてください。" >&2
  exit 1
fi

for pair in "${FILES[@]}"; do
  dest="${pair%%|*}"; src="${pair##*|}"
  mkdir -p "$TARGET/$(dirname "$dest")"
  cp "$KIT/$src" "$TARGET/$dest"
  echo "  配置 $dest"
done

mkdir -p "$TARGET/.gitea/scripts"
for s in "${SCRIPTS[@]}"; do
  cp "$KIT/scripts/$s" "$TARGET/.gitea/scripts/$s"
  echo "  配置 .gitea/scripts/$s"
done

cat <<'NEXT'

配置しました。続けて次を行ってください。

  1. refs.json を自分の参照リポジトリに書き換える
  2. .claude/skills/issue-ai-reply/SKILL.md の「前提環境」の表を refs.json と揃える
  3. リポジトリに help-AI ラベルを作る
  4. Secrets を登録する（ANTHROPIC_API_KEY / BOT_TOKEN / BOT_LOGIN / REF_TOKEN）
  5. python3 .gitea/scripts/check_sync.py で一覧の食い違いが無いか確かめる

詳しい手順は docs/セットアップ.md にあります。
NEXT
