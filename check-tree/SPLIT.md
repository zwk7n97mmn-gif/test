# このフォルダを独立したリポジトリにする

**ツリーと実体の突き合わせ** です。このフォルダ（`check-tree/`）は**そのままで1つのリポジトリとして動きます**。<br>
切り出したら、**このファイルは消してください。**

## 中身が閉じていることの確認

| 確認したこと | 結果 |
| --- | --- |
| 隣のリポジトリへの依存 | 無し |
| テスト | 単体のクローンで全項目 OK |

> ℹ️ このリポジトリは**配布元**です。他のリポジトリにある `check_tree.py` は
> ここからコピーしたものなので、直すときは**必ずここを直して**配り直してください。

---

## 手順A：履歴ごと切り出す（おすすめ）

「いつ・誰が・なぜ書いたか」が残ります。

```bash
# 1. check-tree だけの履歴を持つブランチを作る
git subtree split --prefix=check-tree -b check-tree-only

# 2. 新しいリポジトリを作る（Gitea / GitHub の画面で。README は作らない）

# 3. 押し込む
git push <新しいリポジトリのURL> check-tree-only:main

# 4. 別の場所にクローンして確かめる
git clone <新しいリポジトリのURL> /path/to/check-tree
cd /path/to/check-tree
bash tests/run_all.sh

# 5. 作業用ブランチを片付ける
git branch -D check-tree-only
```

> ⚠️ **新しいリポジトリは空で作ってください。**<br>
> README を自動生成すると、押し込むときに履歴がぶつかります。

---

## 手順B：まっさらから始める

履歴が要らないときはこちらが簡単です。

```bash
cp -r check-tree /path/to/check-tree-new
cd /path/to/check-tree-new
rm SPLIT.md
git init -b main
git add -A
git commit -m "check-tree: 最初のコミット"
git remote add origin <新しいリポジトリのURL>
git push -u origin main
```

---

## 切り出した後にやること

| # | やること |
| --- | --- |
| 1 | `SPLIT.md` を消す |
| 2 | 元のリポジトリから `check-tree/` を消す（`git rm -r check-tree`） |
| 3 | 新しいリポジトリの URL を、リポジトリ一覧に登録する |
| 4 | 確認コマンドが通ることを見る（`bash tests/run_all.sh`） |
