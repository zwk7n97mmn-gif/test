#!/usr/bin/env bash
# 配布用の ZIP を作る。
#
#   bash taskdeck/tools/build.sh            # 既定のバージョンで作る
#   VERSION=1.1.0 bash taskdeck/tools/build.sh
#
# 秘密鍵（keys/）は絶対に ZIP に入れない。公開鍵が未設定なら止まる。

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="${VERSION:-1.0.0}"
STAGE="$(mktemp -d)"
OUTDIR="$ROOT/dist"
OUT="$OUTDIR/taskdeck-$VERSION.zip"

trap 'rm -rf "$STAGE"' EXIT

echo "TaskDeck $VERSION を組み立てます"

# 1. 公開鍵が入っているか確認する（未設定のまま売るとキーを登録できない）
if grep -q 'const LICENSE_PUBLIC_KEY = "__PUBLIC_KEY__";' "$ROOT/app/taskdeck.html"; then
  echo "エラー: アプリに公開鍵が入っていません。" >&2
  echo "       先に  python taskdeck/tools/keygen.py init  を実行してください。" >&2
  exit 1
fi

# 2. 動作の確認（ここで落ちるものは配らない）
python3 "$ROOT/tests/test_license.py" > /dev/null
echo "  ライセンスの検証テスト: OK"

# 3. 配布物を並べる
mkdir -p "$STAGE/TaskDeck"
cp "$ROOT/app/taskdeck.html"          "$STAGE/TaskDeck/TaskDeck.html"
cp "$ROOT/docs/MANUAL.md"             "$STAGE/TaskDeck/使い方マニュアル.md"
cp "$ROOT/legal/EULA.md"              "$STAGE/TaskDeck/使用許諾契約書.md"
cp "$ROOT/docs/README-FOR-BUYER.txt"  "$STAGE/TaskDeck/はじめにお読みください.txt"

# 4. 秘密鍵が紛れ込んでいないか最終確認
if grep -rl "private_key" "$STAGE" 2>/dev/null | grep -q .; then
  echo "エラー: 配布物に秘密鍵らしき文字列が含まれています。中止しました。" >&2
  exit 1
fi

# 5. ZIP にまとめる
mkdir -p "$OUTDIR"
rm -f "$OUT"
(cd "$STAGE" && zip -q -r "$OUT" TaskDeck)

echo "  出力: ${OUT#"$ROOT/"}  ($(du -h "$OUT" | cut -f1))"
echo "完了しました。この ZIP をそのまま販売ページに置けます。"
