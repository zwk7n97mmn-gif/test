# 心理学の豆知識アカウント

心理学の研究知見を、Bluesky と X に **1 日 2 回（8:00 / 21:00 JST）** 自動投稿します。
サーバー不要、依存パッケージゼロ、GitHub Actions だけで動きます。

## 状態

| 項目 | 内容 |
|---|---|
| コンテンツ | **180 件**（1 日 2 回で **90 日分**） |
| カテゴリ | 記憶・学習 / 認知バイアス / 対人・社会 / 感情・メンタル / 習慣・行動変容 / 意思決定 / 睡眠・身体 / 仕事・生産性 |
| 投稿先 | Bluesky、X（片方だけでも動作） |
| 出典 | 全 180 件に査読論文の出典あり |
| 依存 | なし（Python 3.11 標準ライブラリのみ） |

## はじめかた

**[docs/SETUP.md](docs/SETUP.md) が唯一やってもらう作業です。**
アカウントを作って API キーを GitHub Secrets に入れるだけ。以降は全自動です。

Bluesky だけなら 5 分で動き始めます。X は後から足せます。

## 仕組み

```
GitHub Actions (cron: 23:00 / 12:00 UTC)
        │
        ├─ src/post.py
        │     ├─ content/tips/*.json から未投稿の 1 件を選ぶ
        │     ├─ Bluesky へ投稿  (src/bluesky.py)
        │     ├─ X へ投稿        (src/xapi.py)
        │     └─ state/posted.json を更新
        │
        └─ 履歴をリポジトリにコミットして戻す
```

投稿の重複防止は `state/posted.json` で管理します。
180 件を一巡するまで同じ内容は出ず、一巡すると順序を変えて次の巡回に入ります。
順序は巡回番号から決定的に生成されるため、状態ファイルが壊れても復元できます。

## ディレクトリ

```
content/tips/     豆知識の本体 (JSON)
src/              投稿ロジック
  post.py           エントリポイント
  tips.py           コンテンツの読み込み・選択
  bluesky.py        AT Protocol クライアント
  xapi.py           X API v2 クライアント (OAuth 1.0a 署名を自前実装)
  textlen.py        X / Bluesky の文字数計算
  state.py          投稿履歴
tests/            検証とテスト
state/posted.json 投稿履歴（自動更新）
docs/SETUP.md     セットアップ手順
docs/EDITORIAL.md 編集方針・除外した俗説の一覧
```

## 手元で試す

```bash
python src/post.py --dry-run       # 次に投稿される内容を表示
python tests/validate.py --report  # 全 180 件の検証と文字数一覧
python tests/test_logic.py         # ロジックのテスト
```

投稿には認証情報が要りますが、上記 3 つはすべて認証なしで動きます。

## 豆知識を追加する

`content/tips/` の JSON に追記して PR を出すと、CI が文字数・出典・重複を
自動で検証します。詳細は [docs/EDITORIAL.md](docs/EDITORIAL.md)。

## 方針

**再現性の確認された研究だけを扱います。** パワーポーズ、学習スタイル、
メラビアンの法則など、SNS で人気だが追試に失敗した「心理学ネタ」は
意図的に除外しています。除外した項目とその理由は
[docs/EDITORIAL.md](docs/EDITORIAL.md) に一覧があります。
