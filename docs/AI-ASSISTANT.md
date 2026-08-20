# AI アシスタント

Issue に **`help-AI`** ラベルを付けると、このリポジトリの資料を読んだ AI が
コメントで答えます。

## できること

- セットアップで詰まった箇所の相談（「X の 403 が消えない」など）
- 仕組みの説明（「一巡したら何が起きる？」）
- 豆知識の書き方・採否の相談（[EDITORIAL.md](EDITORIAL.md) の方針に沿って答えます）
- コード変更の提案（変更後のコードを提示します）

## できないこと

- **リポジトリを書き換えること。** できるのは返信だけです。必要な変更は手順として返ってきます。
- **資料にないことに答えること。** 「資料にはありません」と返します。推測では答えません。
- **実行中のワークフローを操作すること。**

---

## 使い方

1. Issues タブ → **New issue** → 質問を書く
2. 右側の **Labels** から `help-AI` を選ぶ
3. 数十秒〜数分で AI がコメントする

**続けて質問できます。** ラベルの付いた Issue に普通にコメントすれば、
それまでのやりとりを踏まえて返信します。ラベルを外せば止まります。

解決したら Issue を閉じてください（閉じても、コメントすれば反応します。
完全に止めるならラベルを外してください）。

---

## セットアップ

### 1. API キーを登録する

[Anthropic Console](https://console.anthropic.com/) でキーを発行し、
Settings → Secrets and variables → Actions → New repository secret に登録します。

| Name | Value |
|---|---|
| `ANTHROPIC_API_KEY` | `sk-ant-...` |

### 2. ラベルを作る

Issues タブ → **Labels** → **New label** → 名前を `help-AI` にして作成。

> 名前は完全一致で見ています。`help-ai` や `Help-AI` では動きません。

### 3. デフォルトブランチに入れる

Issue 関連のイベントは、**デフォルトブランチにあるワークフロー定義**で動きます。
`.github/workflows/ai-assist.yml` が `main` にマージされるまでは反応しません。

これで完了です。キーを登録しなければ、ワークフローは失敗するだけで
定期投稿には影響しません。

---

## AI が読むもの

回答のたびに、次のファイルをすべて読んでから答えます。

```
README.md
docs/*.md
src/*.py
.github/workflows/*.yml
```

現在およそ 4.9 万文字（約 3 万トークン）です。

**この範囲に資料を足せば、コードを触らなくても回答の材料が増えます。**
逆に、ここに書かれていないことは答えられません。同じ質問が繰り返し来るなら、
回答を `docs/` に書き足すのが正しい対処です。

範囲を変えたいときは `src/ai_assist.py` の `REFERENCE_GLOBS` を編集します。

> `state/posted.json` と `content/tips/*.json` は範囲外です。
> 毎回変わるうえ量が多く、入れるとキャッシュが効かなくなるためです。

---

## 費用

| | 単価 |
|---|---|
| 入力 | $5 / 100万トークン |
| 出力 | $25 / 100万トークン |

資料が約 3 万トークンなので、**1 往復あたりおおむね 20〜40 円**が目安です。
同じ Issue で続けて質問した場合はプロンプトキャッシュが効くため、
2 回目以降は安くなります。

正確な単価は [Anthropic の料金ページ](https://www.anthropic.com/pricing)を確認してください。
使用量の上限は Anthropic Console 側で設定できます。

---

## 暴走しないための仕組み

| 仕掛け | 内容 |
|---|---|
| bot のコメントには反応しない | ワークフローの条件で `user.type != 'Bot'` を見ています。AI 同士が延々と返信し合うことはありません |
| 1 Issue あたり 20 返信まで | `src/ai_assist.py` の `MAX_BOT_REPLIES`。超えたら黙って止まります |
| 同時実行しない | `concurrency` で Issue ごとに直列化。返信が二重になりません |
| 長すぎるスレッドは断る | 40 万文字を超えたら、切り詰めずに「分けてほしい」と返します |
| ラベル方式 | ラベルを付けた Issue だけが対象。付けなければ 1 円もかかりません |

Issue は誰でも書けるため、本文に書かれた指示で役割を乗っ取られないよう、
システムプロンプト側で明示的に禁じています（`src/ai_assist.py` の `SYSTEM_PROMPT`）。

---

## 返信が来ないとき

Actions タブ → 「AI アシスタント」に実行履歴があるかを先に見てください。

| 実行履歴 | 原因 |
|---|---|
| そもそも実行されていない | ラベル名が `help-AI` と完全一致していない。またはワークフローがまだデフォルトブランチに入っていない |
| 実行が赤（失敗） | ログを開く。`ANTHROPIC_API_KEY` 未設定・キーの失効・残高切れがほとんど |
| 実行が緑だがコメントがない | `すでに 20 件返信済み` でログが止まっている（`MAX_BOT_REPLIES`）。新しい Issue を立ててください |
| bot のコメントに反応しない | 仕様です。人間のコメントにだけ反応します |

ワークフローが失敗すると、GitHub からリポジトリ所有者にメールが届きます。

---

## 止める

| やりたいこと | 操作 |
|---|---|
| その Issue だけ止める | `help-AI` ラベルを外す |
| 全部止める | Actions タブ → 「AI アシスタント」→ `...` → Disable workflow |
| 完全に無効化する | Secret `ANTHROPIC_API_KEY` を削除する |

---

## 手元で試す

```bash
pip install "anthropic>=0.125,<1"
export ANTHROPIC_API_KEY=sk-ant-...
export GITHUB_TOKEN=ghp_...          # public_repo 権限があれば足ります
python src/ai_assist.py --repo owner/repo --issue 12 --dry-run
```

`--dry-run` を付けると、投稿せずに返信案を表示するだけです。

GitHub 上から試すなら、Actions タブ → 「AI アシスタント」→ Run workflow で
Issue 番号を指定します（`dry_run` にチェックを入れるとログに出るだけです）。

---

## 仕組み

```
Issue に help-AI ラベルが付く / ラベル付き Issue にコメントが付く
        │
        └─ .github/workflows/ai-assist.yml
              └─ src/ai_assist.py
                    ├─ load_reference()   README / docs / src / workflows を読む
                    ├─ fetch_issue()      Issue 本文を取る
                    ├─ fetch_comments()   コメント欄を全ページ取る
                    ├─ build_messages()   Issue とコメントを会話履歴に変換
                    ├─ answer()           Claude API に投げる
                    └─ post_comment()     返信を投稿する
```

コメント欄はそのまま会話履歴になります。人のコメントが `user`、
AI 自身のコメントが `assistant` に対応するので、スレッドを読み返す形で
文脈が引き継がれます。状態ファイルは使いません。

投稿側（`src/post.py`）とは完全に独立していて、依存も共有しません。
このアシスタントが壊れても定期投稿は止まりません。
