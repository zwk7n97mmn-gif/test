# 独立したリポジトリとして切り出す手順

この `taskdeck-docs/` は、そのまま別リポジトリの中身になるよう作ってあります。
製品コードのリポジトリから切り出すときは、次のどちらかを実行してください。

## A. 履歴ごと切り出す（おすすめ）

このディレクトリだけのコミット履歴を持った新しいリポジトリになります。

```bash
# 1. GitHub で空のリポジトリ taskdeck-docs を作る（README を作らない設定で）

# 2. このディレクトリを履歴ごと切り出す
git subtree split --prefix=taskdeck-docs -b docs-only

# 3. 新しいリポジトリへ押し出す
git push git@github.com:<あなた>/taskdeck-docs.git docs-only:main

# 4. 元のリポジトリから取り除く（任意）
git rm -r taskdeck-docs
git commit -m "docs: ドキュメントを taskdeck-docs リポジトリへ移した"
```

## B. 中身だけコピーする

履歴が要らない場合は、こちらのほうが簡単です。

```bash
mkdir ../taskdeck-docs && cp -r taskdeck-docs/. ../taskdeck-docs/
cd ../taskdeck-docs
git init -b main
git add -A
git commit -m "docs: TaskDeck のドキュメントを追加"
git remote add origin git@github.com:<あなた>/taskdeck-docs.git
git push -u origin main
```

## 切り出したあとに直す場所

製品コードを指しているリンクは、切り出すと切れます。次の 1 か所だけです。

| ファイル | リンク先 | 直しかた |
|---|---|---|
| `docs/設計/セキュリティ設計.md` | `../../../taskdeck/legal/EULA.md` | 製品リポジトリの GitHub URL に置き換える |

確認は次のコマンドでできます。

```bash
grep -rn "](.*taskdeck/" --include="*.md" .
```

製品リポジトリ側の `taskdeck/README.md` にも、この文書群へのリンクが 2 か所あります。
そちらも新しい URL に向け直してください。

## 公開する場合

仕様書（`docs/仕様/`）と拡張の作り方（`docs/開発/拡張の作り方.md`）は、
外部の開発者に拡張を作ってもらうときにそのまま渡せます。
販売の内部事情（価格の考えかたなど）はこの文書群には含めていないため、
リポジトリごと公開しても差し支えありません。
