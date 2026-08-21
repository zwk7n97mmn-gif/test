# このwikiを独立したリポジトリにする

このフォルダ（`wiki/`）は**そのままで1つのリポジトリとして動きます**。
親リポジトリから切り出すときの手順です。**切り出したらこのファイルは消してください。**

> ℹ️ 検査の対象外にしてあります（`wiki-lint.json` の `exclude`）。
> 作業用のメモであって、wiki のページではないためです。

---

## 中身が閉じていることの確認

| 確認したこと | 結果 |
| --- | --- |
| 親フォルダを参照しているリンク | 無し |
| 検査（`scripts/wiki_lint.py`） | 単体のクローンで全 11 項目 OK |
| 自動実行（`.gitea/workflows/wiki-lint.yml`） | リポジトリ直下起点。そのまま動く |

---

## 手順A：履歴ごと切り出す（おすすめ）

「いつ・誰が・なぜ書いたか」が残ります。

```bash
# 1. wiki/ だけの履歴を持つブランチを作る
git subtree split --prefix=wiki -b wiki-only

# 2. 新しいリポジトリを作る（Gitea / GitHub の画面で。README は作らない）

# 3. 押し込む
git push <新しいリポジトリのURL> wiki-only:main

# 4. 別の場所にクローンして確かめる
git clone <新しいリポジトリのURL> /path/to/develop-wiki
cd /path/to/develop-wiki
python3 scripts/wiki_lint.py     # すべて OK になること

# 5. 作業用ブランチを片付ける
git branch -D wiki-only
```

> ⚠️ **新しいリポジトリは空で作ってください。**<br>
> README を自動生成すると、押し込むときに履歴がぶつかります。

---

## 手順B：まっさらから始める

履歴が要らないときはこちらが簡単です。

```bash
cp -r wiki /path/to/develop-wiki
cd /path/to/develop-wiki
rm SPLIT.md
git init -b main
git add -A
git commit -m "wiki: 最初のコミット"
git remote add origin <新しいリポジトリのURL>
git push -u origin main
```

---

## 切り出した後にやること

| # | やること |
| --- | --- |
| 1 | `SPLIT.md` を消す |
| 2 | 親リポジトリの `wiki/` を消す（`git rm -r wiki`） |
| 3 | 新しいリポジトリの URL を、リポジトリ一覧に登録する |
| 4 | 自動実行が動いたか確かめる（初回の push で走る） |

---

## 検査を最新にする

決まりごとの検査（`scripts/wiki_lint.py`）は `wiki-kit` が配布元です。
新しい検査が増えたら、キット側から入れ直します。

```bash
bash /path/to/wiki-kit/scripts/install.sh /path/to/develop-wiki
```

`README.md` `CLAUDE.md` `wiki-lint.json` `wikiの編集方法/` は**上書きされません**。
入れ替わるのは検査本体と自動実行の定義だけです。
