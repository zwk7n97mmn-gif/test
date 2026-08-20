# AI アシスタント

Issue に **`help-AI`** ラベルを付けると、このリポジトリを読んだ Claude が
コメントで答えます。

公式の [Claude Code Action](https://github.com/anthropics/claude-code-action) を使い、
**Claude サブスクリプションの枠内**で動かします。API の従量課金は発生しません。

## できること

- セットアップで詰まった箇所の相談（「X の 403 が消えない」など）
- 仕組みの説明（「一巡したら何が起きる？」）
- 豆知識の書き方・採否の相談（[EDITORIAL.md](EDITORIAL.md) の方針に沿って答えます）
- コード変更の提案（変更後の差分を提示します）

## できないこと

- **リポジトリを書き換えること。** ワークフローは `contents: read` で動きます。
  必要な変更は手順として返ってきます（広げ方は下の「権限を広げる」参照）。
- **資料にないことに答えること。** 「資料にはありません」と返します。

---

## 使い方

1. Issues タブ → **New issue** → 質問を書く
2. 右側の **Labels** から `help-AI` を選ぶ
3. 数十秒〜数分で Claude がコメントする

**続けて質問するときは、コメント本文に `@claude` を含めてください。**
ラベルは最初の呼び出し用、`@claude` は会話継続用です。

> `@claude` を付けないコメントには反応しません。うっかり長い議論を
> 全部 AI に読ませてしまう事故を防ぐための仕様です。

---

## セットアップ

### 1. Claude GitHub App を入れる

[Claude GitHub App](https://github.com/apps/claude) をこのリポジトリにインストールします。

### 2. サブスクリプションのトークンを発行する

手元の Claude Code で次を実行します。

```bash
claude setup-token
```

出てきたトークンを、Settings → Secrets and variables → Actions → New repository secret に登録します。

| Name | Value |
|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | `claude setup-token` の出力 |

> **`ANTHROPIC_API_KEY` は使いません。** そちらは Console の従量課金アカウントに
> 紐づくため、サブスクとは別に請求が発生します。

トークンは `claude setup-token` を実行した人のサブスクリプションに紐づきます。
Pro / Max / Team / Enterprise で利用できます。

### 3. ラベルを作る

Issues タブ → **Labels** → **New label** → 名前を `help-AI` にして作成。

> 名前は完全一致です。`help-ai` や `Help-AI` では動きません。
> 変えたい場合はワークフローの `label_trigger` も合わせて書き換えてください。

### 4. デフォルトブランチに入れる

Issue 関連のイベントは、**デフォルトブランチにあるワークフロー定義**で動きます。
`.github/workflows/ai-assist.yml` が `main` にマージされるまでは反応しません。

---

## 費用

**追加課金は発生しません。** ただし条件が 2 つあります。

### Usage credits を OFF にしておく

claude.ai → Settings → Usage → **Usage credits**。

- **OFF**（既定）: プランの枠に達したら**そこで止まるだけ**。請求は発生しません。
- **ON**: 枠を超えた分が課金されます。追加課金を避けたいならこちらは切っておいてください。

### GitHub Actions の実行時間は別会計

Anthropic ではなく GitHub 側の課金です。

- **public リポジトリ**: 無料
- **private リポジトリ**: プランの無料枠（Free は月 2,000 分）を消費します

### 枠は自分の利用分と共有です

お金は増えませんが、**サブスクの枠は Claude Code や Claude チャットと共有**です。
5 時間ごと・週ごとのウィンドウ制なので、Issue bot を回した分だけ
自分の持ち分が減ります。枠の消費を抑えたい場合は、ワークフローの
`claude_args` にモデル指定を足してください。

```yaml
claude_args: |
  --max-turns 10
  --model claude-sonnet-5
```

Opus には専用の上限が別にあるため、Sonnet を指定しておくと
Opus の枠を温存できます。

---

## 暴走しないための仕組み

| 仕掛け | 内容 |
|---|---|
| 書き込み権限のある人だけ | Action が、トリガーした人にリポジトリの write 権限があるか確認します。部外者が Issue を立てても動きません |
| bot は弾かれる | bot が起点の実行は拒否されます。AI 同士が延々と返信し合うことはありません |
| ラベル方式 | `help-AI` を付けた Issue だけが対象。付けなければ枠を一切使いません |
| 継続には `@claude` が必要 | ラベル付き Issue でも、普通のコメントには反応しません |
| ターン数の上限 | `--max-turns 10`。1 回の実行で延々と作業を続けません |
| タイムアウト | `timeout-minutes: 15` |
| 同時実行しない | `concurrency` で Issue ごとに直列化。返信が二重になりません |

Issue 本文で役割を乗っ取られないよう、答え方の方針は
リポジトリ直下の `CLAUDE.md` に書いてあります（Claude が毎回読みます）。

---

## 返信が来ないとき

Actions タブ → 「AI アシスタント」に実行履歴があるかを先に見てください。

| 実行履歴 | 原因 |
|---|---|
| そもそも実行されていない | ラベル名が `help-AI` と完全一致していない。またはワークフローがまだデフォルトブランチに入っていない |
| 実行が赤（失敗） | ログを開く。`CLAUDE_CODE_OAUTH_TOKEN` 未設定・トークン失効・GitHub App 未インストールがほとんど |
| `write access` で止まっている | トリガーした人にリポジトリの書き込み権限がない。許可するなら `allowed_non_write_users` を設定します |
| 枠切れ | サブスクの利用上限。ウィンドウがリセットされるまで待ちます |
| コメントに反応しない | 本文に `@claude` が入っていない（仕様です） |

ワークフローが失敗すると、GitHub からリポジトリ所有者にメールが届きます。

---

## 止める

| やりたいこと | 操作 |
|---|---|
| その Issue だけ止める | `help-AI` ラベルを外す |
| 全部止める | Actions タブ → 「AI アシスタント」→ `...` → Disable workflow |
| 完全に無効化する | Secret `CLAUDE_CODE_OAUTH_TOKEN` を削除する |

---

## 権限を広げる

既定では質問に答えるだけで、リポジトリは書き換えません。
PR を作らせたい場合は `.github/workflows/ai-assist.yml` の `permissions` を
次のように変えます。

```yaml
permissions:
  contents: write        # read から変更
  pull-requests: write   # 追加
  issues: write
  id-token: write
  actions: read
```

`CLAUDE.md` の「リポジトリを書き換えられません」という記述も
合わせて直してください。

---

## 参考

- [Claude Code GitHub Actions](https://code.claude.com/docs/en/github-actions) — 認証と課金の説明
- [claude-code-action](https://github.com/anthropics/claude-code-action) — 入力の一覧
- [コスト管理](https://code.claude.com/docs/en/costs) — 枠と usage credits の関係
