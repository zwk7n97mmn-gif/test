# セットアップ手順

あなたにやってもらう作業はここだけです。以降は全自動で動きます。
所要時間の目安は Bluesky が 5 分、X が 20〜30 分（審査待ちを除く）。

---

## 0. 先に決めること: アカウント名

両方のプラットフォームで同じ名前を取るのが望ましいです。候補の例:

- `kokoro-note` / こころノート
- `psy-tips` / 心理学の豆知識
- `mainichi-shinri` / 毎日心理学

プロフィール文の例（そのまま使えます）:

> 心理学の研究から、日常で使える知見を毎日2回。朝8時と夜9時。
> 出典のある内容だけを扱い、追試で否定された俗説は載せません。

---

## 1. Bluesky（推奨・先にこちらだけでも動きます）

### 1-1. アカウントを作る
1. https://bsky.app/ で登録
2. ハンドル（`○○.bsky.social`）を決める

### 1-2. アプリパスワードを発行する
1. 設定 → プライバシーとセキュリティ → アプリパスワード
2. 「アプリパスワードを追加」→ 名前は `github-actions` など
3. 表示された `xxxx-xxxx-xxxx-xxxx` をコピー

> **本アカウントのログインパスワードは使わないでください。**
> アプリパスワードは、漏れても後から個別に失効させられます。

### 1-3. GitHub に登録する
リポジトリの Settings → Secrets and variables → Actions → New repository secret

| Name | Value |
|---|---|
| `BLUESKY_HANDLE` | `あなたのハンドル.bsky.social` |
| `BLUESKY_APP_PASSWORD` | `xxxx-xxxx-xxxx-xxxx` |

**この時点で Bluesky への自動投稿は動き始めます。** X は後から足せます。

---

## 2. X (Twitter)

X は無料枠でも**書き込みは月 500 投稿まで**です。
1 日 1 回 = 月約 30 投稿なので、無料枠で十分収まります。

### 2-1. 開発者登録
1. https://developer.x.com/ で Sign up
2. 利用目的を英語で記入する欄があります。以下をそのまま使えます:

> I run a personal, non-commercial account that posts short educational
> tips about psychology research in Japanese. The app will only post
> original text content to my own account on a fixed schedule
> (twice per day). It does not read, collect, or analyze other users'
> data, and it does not use the API for any commercial purpose.

### 2-2. アプリを作って権限を設定する
1. Developer Portal → Projects & Apps → アプリを作成
2. **User authentication settings** を開く
3. **App permissions を `Read and write` に変更**（重要）
4. Type of App は `Web App, Automated App or Bot`
5. Callback URI と Website URL は使わないので、リポジトリの URL などで可

### 2-3. キーを発行する
「Keys and tokens」タブで 4 つ発行します。

> **必ず権限を Read and write にしてから Access Token を発行してください。**
> Read only の状態で発行したトークンは、後から権限を上げても無効のままで、
> 投稿時に 403 になります。その場合は Access Token を再発行してください。

### 2-4. GitHub に登録する

| Name | Value |
|---|---|
| `X_API_KEY` | API Key (Consumer Key) |
| `X_API_SECRET` | API Key Secret |
| `X_ACCESS_TOKEN` | Access Token |
| `X_ACCESS_TOKEN_SECRET` | Access Token Secret |

---

## 3. 動作確認

投稿を待たずに、その場で確かめられます。

### 3-1. 投稿せずに内容だけ見る
Actions タブ → 「定期投稿」→ Run workflow → `dry_run` に **チェックを入れて** 実行。
ログに、次に投稿される文面がそのまま出ます。

### 3-2. 実際に 1 件投稿してみる
同じ画面で `dry_run` の**チェックを外して**実行。
- 片方だけ試すなら `only` に `bluesky` または `x` を指定
- 成功すると `state/posted.json` を更新するコミットが自動で入ります

---

## 4. これで完了です

以降は毎日 **8:00 と 21:00（日本時間）** に自動投稿されます。

- 180 件を重複なしで一巡（**90 日分**）
- 一巡し終わると、順序を変えて次の巡回に入る
- 同じカテゴリが連続しないよう調整される

---

## 補足

### 投稿時刻を変えたい
`.github/workflows/post.yml` の `cron` を編集します。**UTC 指定**なので、
日本時間から 9 時間引いてください（例: 7:00 JST → `0 22 * * *`）。

### 実行時刻は正確ではありません
GitHub Actions の定期実行は、混雑時に数分〜数十分遅れることがあります。
「毎日きっかり 8:00」ではなく「毎朝 8 時台」くらいに考えてください。
これは GitHub 側の仕様で、こちら側では制御できません。

### 失敗したときの通知
ワークフローが失敗すると、GitHub からリポジトリ所有者にメールが届きます
（Settings → Notifications で調整可能）。

失敗しても、その回の豆知識は**消費されません**。次回に持ち越されます。

### 片方だけ落ちた場合
Bluesky と X は独立して投稿します。片方が失敗しても、もう片方は投稿され、
ログに失敗した側だけが記録されます。

X が月間上限に達した場合は「失敗」ではなく「見送り」として扱われ、
ワークフロー自体は成功します（Bluesky には投稿済みのため）。

### 停止したいとき
Actions タブ → 「定期投稿」→ 右上の `...` → Disable workflow

### 鍵を漏らしてしまったら
- Bluesky: 設定からそのアプリパスワードを削除して再発行
- X: Developer Portal で Regenerate

いずれも GitHub Secrets の値を新しいものに差し替えれば復旧します。
