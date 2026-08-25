# このフォルダを独立したリポジトリにする

**Gitea の Issue に AI が返信する仕組み** です。このフォルダ（`gitea-ai-issue-reply/`）は**そのままで1つのリポジトリとして動きます**。<br>
切り出したら、**このファイルは消してください。**

## 中身が閉じていることの確認

| 確認したこと | 結果 |
| --- | --- |
| 隣のリポジトリへの依存 | 無し（`check_tree.py` は同梱済み） |
| テスト | 単体のクローンで全項目 OK。通信はしない |

> ℹ️ `scripts/check_tree.py` は `check-tree` リポジトリからコピーしたものです。
> 配布元と同じかを確かめるには、切り出した後は場所を教えてください。
>
> ```bash
> CHECK_TREE_UPSTREAM=/path/to/check-tree/check_tree.py bash tests/run_all.sh
> ```
>
> 教えなくてもテストは落ちません（比較を飛ばすだけです）。

---

## 手順A：履歴ごと切り出す（おすすめ）

「いつ・誰が・なぜ書いたか」が残ります。

```bash
# 1. gitea-ai-issue-reply だけの履歴を持つブランチを作る
git subtree split --prefix=gitea-ai-issue-reply -b gitea-ai-issue-reply-only

# 2. 新しいリポジトリを作る（Gitea / GitHub の画面で。README は作らない）

# 3. 押し込む
git push <新しいリポジトリのURL> gitea-ai-issue-reply-only:main

# 4. 別の場所にクローンして確かめる
git clone <新しいリポジトリのURL> /path/to/gitea-ai-issue-reply
cd /path/to/gitea-ai-issue-reply
bash tests/run_all.sh

# 5. 作業用ブランチを片付ける
git branch -D gitea-ai-issue-reply-only
```

> ⚠️ **新しいリポジトリは空で作ってください。**<br>
> README を自動生成すると、押し込むときに履歴がぶつかります。

---

## 手順B：まっさらから始める

履歴が要らないときはこちらが簡単です。

```bash
cp -r gitea-ai-issue-reply /path/to/gitea-ai-issue-reply-new
cd /path/to/gitea-ai-issue-reply-new
rm SPLIT.md
git init -b main
git add -A
git commit -m "gitea-ai-issue-reply: 最初のコミット"
git remote add origin <新しいリポジトリのURL>
git push -u origin main
```

---

## 切り出した後にやること

| # | やること |
| --- | --- |
| 1 | `SPLIT.md` を消す |
| 2 | 元のリポジトリから `gitea-ai-issue-reply/` を消す（`git rm -r gitea-ai-issue-reply`） |
| 3 | 新しいリポジトリの URL を、リポジトリ一覧に登録する |
| 4 | 確認コマンドが通ることを見る（`bash tests/run_all.sh`） |
