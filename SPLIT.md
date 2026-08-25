# このフォルダを独立したリポジトリにする

**TaskDeck（製品本体）** です。このフォルダ（`taskdeck/`）は**そのままで1つのリポジトリとして動きます**。<br>
切り出したら、**このファイルは消してください。**

## 中身が閉じていることの確認

| 確認したこと | 結果 |
| --- | --- |
| 親フォルダを参照しているパス | 無し（コマンドはすべてリポジトリ直下起点） |
| テスト | 単体のクローンで **69 項目すべて OK**（実ブラウザ分を含む） |
| `.gitignore` | このリポジトリ用のものを同梱（`keys/` `dist/` を除外） |

> 🚨 **`keys/` は絶対にコミットしないでください。**<br>
> 秘密鍵が入ります。出た時点で誰でもライセンスを発行できます。
> 切り出した先でも `.gitignore` が効いていることを必ず確かめてください。

> ℹ️ 実ブラウザのテストには `npm i playwright` が要ります。
> 入っていないときは自動で飛ばすので、テストは落ちません。

---

## 手順A：履歴ごと切り出す（おすすめ）

「いつ・誰が・なぜ書いたか」が残ります。

```bash
# 1. taskdeck だけの履歴を持つブランチを作る
git subtree split --prefix=taskdeck -b taskdeck-only

# 2. 新しいリポジトリを作る（Gitea / GitHub の画面で。README は作らない）

# 3. 押し込む
git push <新しいリポジトリのURL> taskdeck-only:main

# 4. 別の場所にクローンして確かめる
git clone <新しいリポジトリのURL> /path/to/taskdeck
cd /path/to/taskdeck
bash tests/run_all.sh

# 5. 作業用ブランチを片付ける
git branch -D taskdeck-only
```

> ⚠️ **新しいリポジトリは空で作ってください。**<br>
> README を自動生成すると、押し込むときに履歴がぶつかります。

---

## 手順B：まっさらから始める

履歴が要らないときはこちらが簡単です。

```bash
cp -r taskdeck /path/to/taskdeck-new
cd /path/to/taskdeck-new
rm SPLIT.md
git init -b main
git add -A
git commit -m "taskdeck: 最初のコミット"
git remote add origin <新しいリポジトリのURL>
git push -u origin main
```

---

## 切り出した後にやること

| # | やること |
| --- | --- |
| 1 | `SPLIT.md` を消す |
| 2 | 元のリポジトリから `taskdeck/` を消す（`git rm -r taskdeck`） |
| 3 | 新しいリポジトリの URL を、リポジトリ一覧に登録する |
| 4 | 確認コマンドが通ることを見る（`bash tests/run_all.sh`） |
