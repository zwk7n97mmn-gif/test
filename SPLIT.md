# このフォルダを独立したリポジトリにする

**TaskDeck のドキュメント集** です。このフォルダ（`taskdeck-docs/`）は**そのままで1つのリポジトリとして動きます**。<br>
切り出したら、**このファイルは消してください。**

## 中身が閉じていることの確認

| 確認したこと | 結果 |
| --- | --- |
| 製品リポジトリを参照しているリンク | 無し（リポジトリ名を文中で示す形に変更済み） |
| 中身 | 説明書・設計・仕様・ADR 25 枚 |

> ℹ️ 製品コードは `taskdeck` リポジトリにあります。**説明だけ**をこちらに置きます。

---

## 手順A：履歴ごと切り出す（おすすめ）

「いつ・誰が・なぜ書いたか」が残ります。

```bash
# 1. taskdeck-docs だけの履歴を持つブランチを作る
git subtree split --prefix=taskdeck-docs -b taskdeck-docs-only

# 2. 新しいリポジトリを作る（Gitea / GitHub の画面で。README は作らない）

# 3. 押し込む
git push <新しいリポジトリのURL> taskdeck-docs-only:main

# 4. 別の場所にクローンして確かめる
git clone <新しいリポジトリのURL> /path/to/taskdeck-docs
cd /path/to/taskdeck-docs
ls docs

# 5. 作業用ブランチを片付ける
git branch -D taskdeck-docs-only
```

> ⚠️ **新しいリポジトリは空で作ってください。**<br>
> README を自動生成すると、押し込むときに履歴がぶつかります。

---

## 手順B：まっさらから始める

履歴が要らないときはこちらが簡単です。

```bash
cp -r taskdeck-docs /path/to/taskdeck-docs-new
cd /path/to/taskdeck-docs-new
rm SPLIT.md
git init -b main
git add -A
git commit -m "taskdeck-docs: 最初のコミット"
git remote add origin <新しいリポジトリのURL>
git push -u origin main
```

---

## 切り出した後にやること

| # | やること |
| --- | --- |
| 1 | `SPLIT.md` を消す |
| 2 | 元のリポジトリから `taskdeck-docs/` を消す（`git rm -r taskdeck-docs`） |
| 3 | 新しいリポジトリの URL を、リポジトリ一覧に登録する |
| 4 | 確認コマンドが通ることを見る（`ls docs`） |
