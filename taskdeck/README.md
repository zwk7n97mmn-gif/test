# TaskDeck — そのまま販売できるタスク管理ツール

HTML ファイル 1 つで動くタスク管理ツールと、それを売るために必要なもの（販売ページ・
ライセンス発行の仕組み・規約・マニュアル）を一式にしたものです。
サーバーは要りません。アプリ本体は外部と通信しません。

```
taskdeck/
├── app/taskdeck.html      製品本体（これ 1 ファイルで完結）
├── landing/index.html     販売ページ（画像は landing/assets/）
├── docs/                  マニュアル・販売手順・メール文面
├── legal/                 使用許諾契約書・特商法表記・プライバシーポリシー
├── tools/                 ライセンス発行（keygen.py）と配布 ZIP 作成（build.sh）
├── tests/                 ライセンスの検証テストと画面操作のテスト
└── dist/                  build.sh が作る配布 ZIP の置き場
```

## 3 手で売り始める

```bash
python3 taskdeck/tools/keygen.py init          # 1. 鍵ペアを作る（最初の一度だけ）
bash taskdeck/tools/build.sh                   # 2. 配布用 ZIP を作る
python3 taskdeck/tools/keygen.py issue --name "購入者名"   # 3. 注文が入ったらキーを発行
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

## ライセンスの仕組み

キーは **楕円曲線署名（P-256）** で署名しています。

- 署名できるのは秘密鍵を持つ販売者だけ（`tools/keygen.py`）
- アプリに入っているのは公開鍵だけなので、配布物を解析されてもキーは作れない
- 検証は端末内で完結する。認証サーバーは不要で、オフラインでも動く

秘密鍵は `keys/private.json` に作られ、`.gitignore` で Git から除外されます。
**必ずリポジトリの外にバックアップしてください。** 失うと新しいキーを発行できなくなります。

## テスト

```bash
python3 taskdeck/tests/test_license.py    # 鍵の発行と検証（Python と JavaScript の一致を確認）
npm i playwright && node taskdeck/tests/ui_smoke.mjs   # 実際のブラウザで画面を操作して確認
```

`build.sh` は ZIP を作る前にライセンスのテストを実行し、
公開鍵が未設定のときは配布物を作らずに止まります。
