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
python3 "$ROOT/tests/test_package.py" > /dev/null
echo "  拡張パッケージの署名テスト: OK"

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

# 6. 拡張（オプション）を 1 つずつ署名して、別売りの ZIP にする
if [ -d "$ROOT/extensions" ]; then
  for EXTDIR in "$ROOT/extensions"/*/; do
    [ -f "$EXTDIR/manifest.json" ] || continue
    # sample- で始まるものは開発者向けの見本なので、販売用の ZIP は作らない
    case "$(basename "$EXTDIR")" in sample-*) continue ;; esac
    EXTID="$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['id'])" "$EXTDIR/manifest.json")"
    EXTVER="$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['version'])" "$EXTDIR/manifest.json")"
    EXTNAME="$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['name'])" "$EXTDIR/manifest.json")"

    python3 "$ROOT/tools/pkg.py" build "$EXTDIR" --out "$OUTDIR" > /dev/null
    python3 "$ROOT/tools/pkg.py" verify "$OUTDIR/$EXTID-$EXTVER.tdpkg" > /dev/null

    EXTSTAGE="$STAGE/ext-$EXTID"
    mkdir -p "$EXTSTAGE/$EXTID"
    cp "$OUTDIR/$EXTID-$EXTVER.tdpkg" "$EXTSTAGE/$EXTID/"
    if [ -f "$EXTDIR/README.md" ]; then
      cp "$EXTDIR/README.md" "$EXTSTAGE/$EXTID/使い方.md"
    fi
    cat > "$EXTSTAGE/$EXTID/はじめにお読みください.txt" <<TXT
$EXTNAME （TaskDeck 拡張 $EXTVER）

■ 入れかた
  1. TaskDeck.html をブラウザで開きます。
  2. 画面右上の「⊞」（拡張）を押します。
  3.「パッケージのファイルを選ぶ」で、このフォルダの $EXTID-$EXTVER.tdpkg を選びます。
  4. 追加されると、左のメニューに項目が増えます。

■ ライセンス
  拡張つきのライセンスキーを「ライセンス」画面で登録すると、件数の制限がなくなります。
  キーを登録するまでは評価としてお使いいただけます。

■ ご注意
  拡張を取り外すと、その拡張が保存したデータも消えます。
  「⇅」→「JSON で書き出す」では拡張のデータは含まれません。
  拡張ごとの書き出し（CSV）をお使いください。
TXT
    EXTZIP="$OUTDIR/taskdeck-$EXTID-$EXTVER.zip"
    rm -f "$EXTZIP"
    (cd "$EXTSTAGE" && zip -q -r "$EXTZIP" "$EXTID")
    echo "  拡張: ${EXTZIP#"$ROOT/"}  ($(du -h "$EXTZIP" | cut -f1))"
  done
fi

echo "完了しました。この ZIP をそのまま販売ページに置けます。"
