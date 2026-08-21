# check-tree — ドキュメントのツリーと実体を照合する

📍`🏠ホーム > 📁check-tree`

---

## 📖 これは何か

README や wiki に書いたフォルダツリーが、**実際のファイル構成とずれていないか**を確かめる 1 ファイルのツールです。

```
📦リポジトリ ※照合しない（説明の図）
 ┣ 📂tools
 ┃ ┗ 📜check_tree.py     ← これ 1 つ。依存なし・Python 3.9 以上
 ┗ 📜README.md            ← ここに書いたツリーを照合する
```

ファイルを増やしたり消したりしたとき、ドキュメントのツリーだけが取り残されます。
読む人はツリーを信じるので、**ズレたまま気づかれないのがいちばん困ります**。
人が気をつけるのをやめて、機械に見張らせます。

<br>

---

## 🌲 フォルダ構成

```
📦check-tree
 ┣ 📂workflows
 ┃ ┗ 📜check-tree.yml     … Gitea Actions の雛形
 ┣ 📂tests
 ┃ ┣ 📜run_all.sh
 ┃ ┗ 📜test_check_tree.py
 ┣ 📜check_tree.py        … 本体。各リポジトリへ配るのはこれ
 ┣ 📜check-tree.json      … 設定の雛形（省略可）
 ┣ 📜ツリー照合.bat        … Windows から実行する用
 ┣ 📜install.sh           … 対象リポジトリへ配置する
 ┗ 📜README.md
```

<br>

---

## 🚀 入れかた

```bash
bash install.sh /path/to/your-repo          # tools/ に置く
bash install.sh /path/to/your-repo scripts  # 置き場を変える場合
```

置かれるもの:

| ファイル | 何のため |
| --- | --- |
| `tools/check_tree.py` | 本体 |
| `tools/ツリー照合.bat` | Windows からダブルクリックで実行する |
| `check-tree.json` | 設定（既定で困らなければ消してよい） |
| `.gitea/workflows/check-tree.yml` | CI で毎回確かめる |

置いたら、README に `📦` で始まるツリーを書きます。下敷きは次で出せます。

```bash
python3 tools/check_tree.py --list
```

<br>

---

## 🌲 ツリーの書き方

```
📦リポジトリ名 ※照合しない（書き方の例）
 ┣ 📂フォルダ
 ┃ ┣ 📜ファイル.sh            … 説明を書いてもよい（照合では無視される）
 ┃ ┗ 📜ファイル2.sh
 ┣ 📂別のフォルダ　　　　※要uv sync
 ┗ 📜README.md
```

- 拾うのは **📂 と 📜 の直後の名前**だけです。`… 説明` や `※注記` は無視します
- 実体ではないツリー（配置後の姿、書き方の例など）は、1 行目を
  **`📦名前 ※照合しない`** にすると飛ばします

## ✅ 何を確かめるか

| 検査 | 見つかるもの |
| --- | --- |
| ツリーに書かれたものが実体にある | 消したファイルがツリーに残っている |
| 直下のものがツリーに載っている | 増やしたファイルをツリーに書き忘れた |

<br>

---

## ⚙️ 設定

リポジトリ直下の `check-tree.json` で変えられます。**無くても動きます。**

| キー | 既定 | 意味 |
| --- | --- | --- |
| `docs` | `["*.md", "docs/**/*.md"]` | ツリーを探すファイル |
| `ignore` | `__pycache__` `node_modules` `.venv` `*.pyc` `*.log` | 実体から外すもの |
| `source` | `"auto"` | `"git"` … git が見ているものを実体とする（`.gitignore` されたものを除く）／`"files"` … ファイルシステムをそのまま歩く |
| `require_listed` | `true` | 直下のものがツリーに載っているかも確かめる |
| `require_tree` | `true` | ツリーが 1 つも無いときに失敗にする |

### `source` の選びかた

**既定の `"auto"` は、git があれば `"git"` になります。** `.gitignore` されたものが
自動で実体から外れるため、`_output/` のような出力先を持つリポジトリではこちらが楽です。
まだコミットしていないファイルも実体として数えます（配置した直後に誤検出しないため）。

`"files"` は `.gitignore` を見ません。生成物まで「ツリーに書け」と言われるので、
出力先を持つリポジトリでは `ignore` を自分で並べることになります。

<br>

---

## 🧪 テスト

```bash
bash tests/run_all.sh
```

一時ディレクトリに偽のリポジトリを作って確かめます。外部への通信はしません。

<br>

---

## 👀 関連ページ

- [Giteaイシュー自動返信キット](../gitea-ai-issue-reply/README.md) … 同じ考え方の検査（参照一覧の照合）を持つ
- [repo-hub](../repo-hub/README.md) … リポジトリ一覧とページの照合
