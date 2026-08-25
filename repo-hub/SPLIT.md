# このフォルダを独立したリポジトリにする

**リポジトリ全体像** です。このフォルダ（`repo-hub/`）は**そのままで1つのリポジトリとして動きます**。<br>
切り出したら、**このファイルは消してください。**

## 中身が閉じていることの確認

| 確認したこと | 結果 |
| --- | --- |
| 隣のリポジトリへの依存 | 無し |
| テスト | 単体のクローンで全項目 OK |

> ⚠️ `リポジトリ全体像.md` の `〔GiteaのURL〕` は**置き換えが必要**です。
> 実際の URL に直すまで、リンクは飛びません。

---

## 手順A：履歴ごと切り出す（おすすめ）

「いつ・誰が・なぜ書いたか」が残ります。

```bash
# 1. repo-hub だけの履歴を持つブランチを作る
git subtree split --prefix=repo-hub -b repo-hub-only

# 2. 新しいリポジトリを作る（Gitea / GitHub の画面で。README は作らない）

# 3. 押し込む
git push <新しいリポジトリのURL> repo-hub-only:main

# 4. 別の場所にクローンして確かめる
git clone <新しいリポジトリのURL> /path/to/repo-hub
cd /path/to/repo-hub
bash tests/run_all.sh

# 5. 作業用ブランチを片付ける
git branch -D repo-hub-only
```

> ⚠️ **新しいリポジトリは空で作ってください。**<br>
> README を自動生成すると、押し込むときに履歴がぶつかります。

---

## 手順B：まっさらから始める

履歴が要らないときはこちらが簡単です。

```bash
cp -r repo-hub /path/to/repo-hub-new
cd /path/to/repo-hub-new
rm SPLIT.md
git init -b main
git add -A
git commit -m "repo-hub: 最初のコミット"
git remote add origin <新しいリポジトリのURL>
git push -u origin main
```

---

## 切り出した後にやること

| # | やること |
| --- | --- |
| 1 | `SPLIT.md` を消す |
| 2 | 元のリポジトリから `repo-hub/` を消す（`git rm -r repo-hub`） |
| 3 | 新しいリポジトリの URL を、リポジトリ一覧に登録する |
| 4 | 確認コマンドが通ることを見る（`bash tests/run_all.sh`） |
