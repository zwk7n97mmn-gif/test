# 見本：カウンタ

拡張の作り方を確かめるための、いちばん小さな見本です。数を数えるだけの拡張です。

新しい拡張を作るときは、このフォルダごと写して、`manifest.json` の `id` と `name` を書き換えてください。

```bash
cp -r taskdeck/extensions/sample-counter taskdeck/extensions/<新しいid>
python3 taskdeck/tools/pkg.py build taskdeck/extensions/<新しいid>
```

この見本で使っている拡張 API:

- `api.storage` … 拡張ごとの保存領域
- `api.registerView` … サイドバーと中央の画面
- `api.registerTaskPanel` … タスク詳細への追加
- `api.ui.injectStyle` / `toast` / `confirm` / `refresh` / `escapeHtml` / `formatStamp`
- `api.entitled` / `api.trialLimit` … ライセンスの利用権と評価中の上限

書き方は `taskdeck-docs/docs/開発/拡張の作り方.md` にあります。
