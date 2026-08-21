# 拡張 API 仕様 v1

拡張のコードに渡される `api` オブジェクトの全機能です。
拡張ができるのは、ここに書いてあることだけです。

対応: TaskDeck 1.0.0 / `manifest.apiVersion` = `"1"`

## 実行のされかた

パッケージの `code` は、次の形で実行されます。

```js
const factory = new Function("api", '"use strict";\n' + code);
factory(api);
```

- トップレベルで `api` を参照できます。`import` / `export` は使えません（モジュールではありません）。
- 起動のたびに実行されます。**同じ処理を何度実行されても同じ結果になるように**書いてください。
- 実行中に例外を投げると、その拡張は自動的に停止し、拡張の一覧に理由が表示されます。

## api の全体

```ts
api = {
  version: "1",
  manifest: Manifest,          // 自分の manifest の複製
  entitled: boolean,           // 製品として使う権利があるか
  trialLimit: number | null,   // 権利が無いときの上限（manifest.trialLimit）。権利があれば null

  storage: { key, get(fallback), set(value) },
  registerView(view), registerTaskPanel(panel), registerExport(exporter),
  tasks: { list(), get(id), create(partial), update(id, patch) },
  ui: { toast, escapeHtml, download, confirm, formatStamp, todayStr, refresh, openTask, injectStyle },
}
```

## storage — 拡張ごとの保存領域

```js
const state = api.storage.get({ entries: [] });   // 無ければ既定値を返す
api.storage.set(state);                            // true / false（容量不足なら false）
```

- 保存先は `taskdeck.ext.<id>.v1`（`api.storage.key` で取得できます）
- 中身の形は拡張が決めます。本体は関与しません
- **拡張が取り外されると、この領域も消えます**
- 本体の JSON バックアップには含まれません。必要なら `registerExport` で書き出し口を用意してください

## registerView — 独自の画面

```js
api.registerView({
  id: "book",          // 拡張の中で一意
  label: "確定申告",    // サイドバーに出る名前
  icon: "¥",           // 1 文字程度
  render(container, ctx) { container.innerHTML = "…"; },
});
```

- `container` は空の `div` です。中身は毎回作り直してください
- `ctx.entitled` は `api.entitled` と同じ値です
- **本体の `render()` が走るたびに呼ばれます。** 入力途中の値は変数に保持し、描き直しのたびに書き戻してください
- この画面を表示している間、タスクの入力欄と「ボード / リスト」の切り替えは隠れます
- 例外を投げても、その場所にメッセージが出るだけで、他の画面は動きます

## registerTaskPanel — タスク詳細への追加

```js
api.registerTaskPanel({
  id: "entries",
  title: "この仕事の記帳",
  render(container, task) { … },
});
```

- タスクの詳細を開くたびに呼ばれます
- `task` はタスクの**複製**です。書き換えても本体には反映されません。変更は `api.tasks.update()` を使ってください

## registerExport — 書き出しの追加

```js
api.registerExport({
  id: "journal-csv",
  label: "仕訳帳CSV",
  run() { api.ui.download("shiwake-2026.csv", text, "text/csv"); },
});
```

「データの保存と読み込み」（⇅）の中に、拡張名つきのボタンとして並びます。

## tasks — 本体のタスク

| 呼びかた | 返り値 | 注意 |
|---|---|---|
| `list()` | タスクの複製の配列 | 並びは保存順。表示順ではありません |
| `get(id)` | タスクの複製 / `null` | |
| `create(partial)` | 作られたタスクの複製 / `null` | 評価版のタスク上限に達していると `null` |
| `update(id, patch)` | 更新後の複製 / `null` | 反映されるのは下表の項目だけ |

`create` が受け取る項目: `title`（必須）、`notes`、`projectId`、`due`、`priority`、`tags`
`update` が受け取る項目: `title`、`notes`、`status`、`priority`、`due`

`id`、`createdAt`、`updatedAt`、`order`、`subtasks` は本体が管理します。拡張からは変えられません。

## ui — 画面まわりの道具

| 関数 | 用途 |
|---|---|
| `toast(message)` | 画面下に短いメッセージを出す |
| `escapeHtml(text)` | HTML に埋める前の無害化。**利用者の入力を表示するときは必ず通す** |
| `download(filename, text, mime)` | ファイルとして保存させる |
| `confirm(message)` | はい / いいえの確認 |
| `formatStamp(iso)` | ISO 日時 → `2026/8/21 14:05` |
| `todayStr(offsetDays?)` | 今日（またはその前後）の `YYYY-MM-DD` |
| `refresh()` | 本体の画面全体を描き直す |
| `openTask(id)` | タスクの詳細パネルを開く |
| `injectStyle(css)` | 拡張の CSS を一度だけ差し込む。本体の CSS 変数（`--accent` など）を使えます |

## やってはいけないこと

- `localStorage` を直接触ること（`api.storage` を使ってください。取り外し時に消えなくなります）
- 本体の DOM を書き換えること（`container` の外に触れると、次の描き直しで消えるか、本体を壊します）
- 外部への通信（製品の約束に反します。署名前の審査で弾かれます）
- グローバル変数の定義（`var` を使わない。`new Function` の中の `const` / `let` に留める）

## 版の扱い

- `manifest.apiVersion` が本体の対応版と違うと、そのパッケージは読み込まれません
- v1 に**項目を足す**ことはあります。既存の拡張は動き続けます
- 項目を**消す・意味を変える**ときは v2 とし、本体は当面 v1 も受け付けます

## 最小の例

```js
const state = api.storage.get({ count: 0 });

api.registerView({
  id: "counter",
  label: "カウンタ",
  icon: "◍",
  render(box) {
    box.innerHTML = `<div class="plugin-host">
      <p>いま ${state.count} 回</p>
      <button class="btn primary" id="inc">数える</button></div>`;
    box.querySelector("#inc").onclick = () => {
      state.count += 1;
      api.storage.set(state);
      api.ui.refresh();
    };
  },
});
```
