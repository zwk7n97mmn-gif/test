# TaskDeck — そのまま販売できるタスク管理ツール

HTML ファイル 1 つで動くタスク管理ツールと、それを売るために必要なもの（販売ページ・
ライセンス発行の仕組み・規約・マニュアル）を一式にしたものです。
サーバーは要りません。アプリ本体は外部と通信しません。

```
taskdeck/
├── app/taskdeck.html      製品本体（これ 1 ファイルで完結）
├── extensions/            オプション（拡張）のソース
│   └── tax/               確定申告データ管理（複式簿記）
├── landing/index.html     販売ページ（画像は landing/assets/）
├── docs/                  マニュアル・販売手順・メール文面
├── legal/                 使用許諾契約書・特商法表記・プライバシーポリシー
├── tools/                 ライセンス発行（keygen.py）、拡張の署名（pkg.py）、配布 ZIP（build.sh）
├── tests/                 署名の検証テストと、実ブラウザでの画面操作テスト
└── dist/                  build.sh が作る配布 ZIP の置き場
```

設計・仕様・拡張の作り方は、別立てのドキュメント集
[`../taskdeck-docs/`](../taskdeck-docs/) にまとめてあります。

## 3 手で売り始める

```bash
python3 taskdeck/tools/keygen.py init          # 1. 鍵ペアを作る（最初の一度だけ）
bash taskdeck/tools/build.sh                   # 2. 本体と拡張の配布 ZIP をまとめて作る
python3 taskdeck/tools/keygen.py issue --name "購入者名"            # 3a. 本体だけの注文
python3 taskdeck/tools/keygen.py issue --name "購入者名" --ext tax  # 3b. 拡張つきの注文
```

詳しい手順は **[docs/SELLING-GUIDE.md](docs/SELLING-GUIDE.md)** にあります。
販売ページの〔　〕を自分の情報に置き換えるところまで、ひと通り書いてあります。

## 製品の中身

| | |
|---|---|
| 形式 | 単一の HTML ファイル（約 76 KB、依存ライブラリなし） |
| 保存先 | ブラウザのローカルストレージ。外部送信なし |
| 主な機能 | ボード／リスト表示、プロジェクト、タグ、サブタスク、優先度、期限、全文検索、ドラッグ移動、ダークテーマ、JSON・CSV 書き出し、印刷、キーボード操作 |
| 入力 | `請求書を送る #経理 !1 @明日` のように 1 行で期限・タグ・優先度まで指定できる |
| 評価版 | タスク 30 件まで。機能の制限なし |
| 対応 | Chrome・Edge・Safari・Firefox の最新版 |

## 拡張（オプション）のしくみ

本体はタスク管理だけを持ち、それ以外は拡張パッケージ（`.tdpkg`）として別に売ります。
拡張が 1 つも入っていないときの動きは、拡張機構が無かったころとまったく同じです。

```
extensions/tax/{manifest.json, main.js}
        │  pkg.py build … 秘密鍵で署名する
        ▼
   tax-1.0.0.tdpkg   ← 購入者に渡すファイル
        │  アプリの「拡張」から読み込む
        ▼
   公開鍵で署名を検証 → 合格したものだけ実行 → 画面・タスクパネル・書き出しが増える
```

拡張が使えるのは、アプリが渡す `api` に書いてあることだけです
（独自画面の登録、タスクの読み書き、拡張ごとの保存領域、書き出しの追加）。
利用権はライセンスキーの中に入っていて、`--ext tax` を付けて発行したキーで制限が外れます。
権利のないキーでも、拡張は評価として動きます（既定で 30 件まで）。

新しい拡張を作るときは `extensions/` に `manifest.json` と `main.js` を置いて
`python3 taskdeck/tools/pkg.py build extensions/<id>` を実行します。
書き方は [`../taskdeck-docs/docs/開発/拡張の作り方.md`](../taskdeck-docs/docs/開発/拡張の作り方.md) にあります。

## ライセンスの仕組み

キーは **楕円曲線署名（P-256）** で署名しています。

- 署名できるのは秘密鍵を持つ販売者だけ（`tools/keygen.py`）
- アプリに入っているのは公開鍵だけなので、配布物を解析されてもキーは作れない
- 検証は端末内で完結する。認証サーバーは不要で、オフラインでも動く

秘密鍵は `keys/private.json` に作られ、`.gitignore` で Git から除外されます。
**必ずリポジトリの外にバックアップしてください。** 失うと新しいキーを発行できなくなります。

## テスト

```bash
python3 taskdeck/tests/test_license.py    # 鍵の発行と検証（Python と JavaScript の一致）
python3 taskdeck/tests/test_package.py    # 拡張パッケージの署名（同上）
npm i playwright
node taskdeck/tests/ui_smoke.mjs          # 実ブラウザ: タスク管理の操作 39 項目
node taskdeck/tests/ui_extension.mjs      # 実ブラウザ: 拡張の署名〜記帳〜取り外し 30 項目
```

`build.sh` は ZIP を作る前にライセンスのテストを実行し、
公開鍵が未設定のときは配布物を作らずに止まります。
