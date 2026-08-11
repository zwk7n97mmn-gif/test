# Kirinuki Studio — 設計書

ブラウザ完結型の動画編集ツール。素材を解析し、**字幕・カット編集・音声処理**を自動付与し、
**サムネイル**と**SNSキャプション**まで生成する。

- バージョン: 1.0.0
- 対象ブラウザ: Chrome / Edge 116+, Safari 17+（`AudioContext.decodeAudioData`, `canvas.captureStream`, `MediaRecorder` 必須）
- 依存パッケージ: **ゼロ**（ビルド不要。素の ES Modules）
- 通信: 既定でネットワーク送信なし。素材はローカル処理のみ。STT を明示設定した場合のみ音声を送信する。

---

## 1. 受け入れ基準（AC）と達成状況

| ID | 受け入れ基準 | 状態 | 検証方法 |
|---|---|---|---|
| AC-01 | 動画ファイル（mp4/webm/mov）を D&D または選択で読み込み、長さ・解像度・fps・音声有無を表示できる | ✅ | 手動 / `test/project.test.js` |
| AC-02 | 素材内容を解析し、**シーン切替点**・**発話区間/無音区間**・**ラウドネス**・**フレーム品質スコア**をタイムラインに可視化する | ✅ | `test/analysis.test.js` |
| AC-03a | 発話区間から字幕セグメント（開始/終了時刻）を自動生成する | ✅ | `test/analysis.test.js` |
| AC-03b | 字幕テキストを自動生成する | ⚠️ 条件付き | STT 設定時は自動。未設定時は「要入力」状態で提示（ダミー文字列を生成しない） |
| AC-04 | 自動生成字幕を表形式で編集でき、SRT/VTT の入出力ができる。行折返しは日本語禁則処理に従う | ✅ | `test/subtitles.test.js` |
| AC-05 | 無音区間の自動カット（前後パディング/最小クリップ長/倍速化モード）を適用でき、プレビューと書き出しの双方に反映される | ✅ | `test/autoedit.test.js` |
| AC-06 | 音声を自動処理する：ラウドネス正規化・BGM の自動ダッキング・フェードイン/アウト | ✅ | `test/audio.test.js` |
| AC-07 | サムネイル候補を自動抽出（品質スコア順）し、テキスト重ねなど編集して PNG 1280×720 で書き出せる | ✅ | `test/thumbnail.test.js` |
| AC-08a | 編集結果を字幕焼き込みつきの動画として書き出せる（進捗表示・キャンセル可） | ✅ | 手動 |
| AC-08b | 書き出しコンテナが MP4 | ⚠️ 条件付き | `MediaRecorder.isTypeSupported('video/mp4')` が真の環境のみ MP4、他は WebM |
| AC-09 | 字幕内容・尺・シーン数から SNS キャプション（X / Instagram / YouTube / TikTok）を生成し、各プラットフォームの文字数上限を超えない | ✅ | `test/captions.test.js` |
| AC-10 | 空状態・ローディング・エラー・境界値（0件 / 5,000件字幕 / 10,000文字テキスト / 0秒素材）で破綻しない | ✅ | `test/*.test.js` の境界値ケース + 手動 |
| AC-11 | すべての操作がキーボードのみで完結し、`aria-*` が付与され、主要文字色のコントラスト比が 4.5:1 以上 | ✅ | `test/a11y-tokens.test.js`（コントラスト比を算出して検証） |
| AC-12 | 作業内容が自動保存され、リロード後に復元できる（Undo/Redo 50 段） | ✅ | `test/project.test.js` |

> ⚠️ の 2 件は「ブラウザ単体・外部依存ゼロ」という制約に起因する技術的限界であり、
> 代替経路（STT プロバイダ設定 / コンテナ自動フォールバック）を実装済み。

---

## 2. アーキテクチャ

```
index.html
└── src/app.js ...................... 合成ルート（DI・イベント配線・キーボード）
    ├── core/ ....................... 純粋関数レイヤ（DOM 非依存 = 単体テスト対象）
    │   ├── util.js ................. タイムコード・数値・ID・非同期ユーティリティ
    │   ├── project.js .............. データモデル / 検証 / Undo・Redo / 永続化
    │   ├── analysis.js ............. RMS 包絡・VAD・シーン検出・フレーム品質
    │   ├── autoedit.js ............. カットプラン生成・タイムライン⇔ソース時刻変換
    │   ├── subtitles.js ............ 分割・禁則折返し・SRT/VTT 相互変換
    │   ├── audio.js ................ 正規化ゲイン計算・ダッキング包絡
    │   ├── thumbnail.js ............ 候補ランキング・テキストレイアウト
    │   ├── captions.js ............. キーワード抽出・キャプション生成
    │   └── stt.js .................. STT プロバイダ抽象（Remote / VADOnly）
    ├── media/ ...................... 副作用レイヤ（WebAudio / Canvas / MediaRecorder）
    │   ├── decoder.js .............. 音声デコード + フレームサンプリング
    │   ├── player.js ............... タイムライン再生エンジン（クリップ連結再生）
    │   └── exporter.js ............. Canvas + WebAudio → MediaRecorder 書き出し
    └── ui/ ......................... ビューレイヤ
        ├── dom.js .................. h() / トースト / ダイアログ / aria-live
        ├── timeline.js ............. 波形・シーン・クリップ・字幕の Canvas 描画
        ├── subtitleEditor.js ....... 仮想スクロール字幕テーブル
        ├── thumbnailEditor.js ...... サムネイル編集
        ├── captionPanel.js ......... キャプション生成
        └── exportPanel.js .......... 書き出し
```

**設計原則**

1. **純粋関数を最大化** — 解析・編集判断・整形はすべて `core/` の副作用なし関数に隔離し、`node --test` で検証する。
2. **単一の真実** — `Project` オブジェクトが唯一の状態。UI は `store.subscribe` で再描画し、変更は必ず `store.commit()` を通す（＝ Undo が常に効く）。
3. **プレビューと書き出しの等価性** — カット・音量・ダッキング・字幕描画は同じ `core/` 関数から導出し、`player.js` と `exporter.js` の双方が同じ結果を使う（見た目と成果物の乖離を防ぐ）。
4. **失敗の明示** — 解析・STT・書き出しはすべて `{ok, value|error}` で返し、UI は原因と次の一手を日本語で提示する。

---

## 3. データモデル

```ts
Project {
  id: string; name: string; version: 1;
  createdAt: number; updatedAt: number;
  media: { name, size, type, duration, width, height, fps, hasAudio } | null;
  analysis: {
    done: boolean;
    envelope: { hopSec: number; db: number[] };      // RMS 包絡 (dBFS)
    speech:  Segment[];                              // 発話区間（ソース時刻）
    scenes:  { start, end, score }[];                // シーン
    frames:  { t, score, sharp, colorful, exposure, contrast }[];
    loudness:{ integratedDb, peakDb, noiseFloorDb };
  };
  clips: Clip[];        // Clip { id, start, end, speed, enabled } — ソース時刻
  subtitles: Cue[];     // Cue { id, start, end, text, needsText } — ソース時刻
  subtitleStyle: { fontSize, family, weight, color, strokeColor, strokeWidth,
                   background, position, maxCharsPerLine, maxLines, safeMargin };
  audio: { normalize, targetDb, duck, duckDb, fadeIn, fadeOut, bgmGainDb, bgmName };
  thumbnail: { sourceTime, template, title, subtitle, accent, scrim, align, badge };
  caption: { platform, tone, includeChapters, includeHashtags, text };
  autoEdit: { enabled, mode:'cut'|'speed', padStart, padEnd, minGap, minClip, speedFactor };
  stt: { providerId:'vad'|'remote', endpoint, model, language };  // apiKey は保存しない
}
```

- 時刻は**すべて秒（number）**、**ソース素材基準**で保持する。タイムライン時刻への写像は `autoedit.js` が一手に引き受ける。
- 動画ファイル自体は永続化しない（容量・権限のため）。復元時は「素材を再選択してください」の空状態に落とす。

---

## 4. 主要アルゴリズム

### 4.1 発話区間検出（VAD）
1. AudioBuffer をモノラル合成 → 窓 25ms / ホップ 10ms の RMS を dBFS 化。
2. **ノイズフロア** = 全フレーム dB の 10 パーセンタイル。
3. 閾値 = `clamp(noiseFloor + 9dB, -55, -20)`。ヒステリシス 3dB（立ち下がりのみ低い閾値）。
4. 立ち上がり確定 60ms、立ち下がり確定 250ms、最小発話長 150ms 未満は棄却。
5. 発話が 1 件も取れない場合は「全区間を 1 セグメント」にフォールバック（＝タイムラインが空にならない）。

### 4.2 シーン検出
1. 0.25 秒間隔で 64×36 に縮小したフレームを取得し、RGB 各 8 ビンのヒストグラム（24 次元, L1 正規化）を作る。
2. 隣接フレーム距離 `d = 0.5 * Σ|a-b|`（0..1）。
3. 閾値 = `max(mean + 2.2*std, 0.22)`。最短シーン長 0.8 秒で吸収。

### 4.3 フレーム品質スコア（サムネイル候補）
`score = 0.40*sharp + 0.20*contrast + 0.20*colorful + 0.20*exposure − 0.25*cutPenalty (+0.10 発話中)`
- `sharp`: グレースケール Laplacian 分散を `log1p` 圧縮して 0..1 正規化
- `colorful`: Hasler–Süsstrunk 指標
- `exposure`: 平均輝度が 0.5 から離れるほど減点
- `cutPenalty`: シーン境界 ±0.3 秒（切替時のブレ・黒フレーム回避）

### 4.4 自動カット
発話区間 → パディング付与 → 間隔 `minGap` 未満は結合 → `minClip` 未満のクリップは前後へ吸収。
`mode:'speed'` では無音を削除せず `speedFactor` 倍速クリップとして残す（テンポを保ちつつ尺短縮）。
タイムライン尺 `Σ (end-start)/speed`。`timelineToSource` / `sourceToTimeline` は単調増加を保証。

### 4.5 音声処理
- **正規化**: 発話区間のみの平均二乗から簡易ラウドネス（LUFS 近似）を算出し `gain = target − measured` を [-12, +18] dB でクランプ、さらに `gain ≤ −1 − peakDb` でクリップ回避。
- **ダッキング**: 発話区間に対し attack 150ms / release 400ms のゲイン自動化点列を生成。`setValueAtTime` + `linearRampToValueAtTime` でプレビュー・書き出し双方に適用。
- **フェード**: タイムライン先頭・末尾に線形フェード（境界: 尺の 1/3 を超えない）。

### 4.6 キャプション生成
字幕テキストから記号・ストップワードを除去し、
①カタカナ連続 ②漢字連続 ③英数語 ④漢字＋ひらがな複合 を候補語として頻度＋長さ重み付けで上位抽出。
プラットフォーム別テンプレート（フック / 本文 / チャプター / ハッシュタグ）で組み立て、
`X:280 / Instagram:2200 / YouTube:5000 / TikTok:2200` 文字を**必ず超えないよう**末尾から段階的に切り詰める。

---

## 5. アクセシビリティ設計

- **キーボード**: `Space` 再生/停止, `←/→` 1 フレーム, `Shift+←/→` 1 秒, `J/K/L` 逆再生/停止/早送り, `I/O` イン点/アウト点, `S` 分割, `X` クリップ無効化, `Ctrl+Z / Ctrl+Shift+Z` Undo/Redo, `1..5` パネル切替, `?` ショートカット一覧。
- **フォーカス**: ダイアログはフォーカストラップ + `Esc` で閉じ、開く前の要素へ復帰。タイムラインは `role="slider"` 相当（`aria-valuenow/valuetext`）で矢印キー操作可能。
- **スクリーンリーダー**: 解析進捗・書き出し進捗・保存状態は `aria-live="polite"`、エラーは `role="alert"`。字幕テーブルは `<table>` + `scope` 付きヘッダ。
- **コントラスト**: デザイントークンを `src/core/tokens.js` に定義し、`test/a11y-tokens.test.js` が WCAG 2.1 相対輝度式で 4.5:1 以上を機械検証する（前景/背景の全組合せ）。
- **モーション**: `prefers-reduced-motion` でトランジションを無効化。
- **拡大**: 400% ズーム / 320px 幅でも横スクロールが発生しないグリッドレイアウト。

---

## 6. 状態設計（空・読込中・エラー）

| 画面 | 空 | 読込中 | エラー |
|---|---|---|---|
| 素材 | ドロップゾーン + 対応形式の明示 | ファイル読込プログレス | 非対応コーデック/破損 → 原因と対処 |
| 解析 | 「解析を実行」CTA | 段階別プログレス（音声デコード → 包絡 → VAD → フレーム → シーン）+ キャンセル | 音声トラック無し → 映像のみモードへ縮退 |
| 字幕 | 0 件表示 + 「自動生成」CTA | STT 進捗（%） | STT 失敗 → VAD 結果は残し再試行導線 |
| サムネ | 候補なし → 現在位置から生成 | 候補抽出中 | 描画失敗（CORS 等）を通知 |
| キャプション | 字幕 0 件時は尺・シーンのみで生成する旨を明示 | 生成中 | — |
| 書き出し | — | 進捗 % + 残り時間 + キャンセル | 対応コーデック無し → 代替コンテナを提示 |

**境界値**: 0 秒素材 / 音声なし / 発話ゼロ / 字幕 0 件・5,000 件（仮想スクロール）/ 1 キュー 10,000 文字（表示は折返し + 省略、書き出しは全文）/ 極端なアスペクト比（縦動画 9:16）/ ファイル 2GB 超（警告表示）。

---

## 7. テスト

```bash
npm test          # node --test（依存ゼロ）
npm start         # 静的サーバで http://localhost:8080
```

`core/` は 100% Node 上で実行可能。`media/` `ui/` は DOM 依存のため手動テスト手順を `docs/QA.md` に記載。

---

## 8. 既知の制約

1. 書き出しは実時間レンダリング（`MediaRecorder`）。10 分の動画は約 10 分かかる。
2. 音声認識テキストは外部 STT 設定時のみ（AC-03b）。
3. コンテナは環境依存で MP4 / WebM（AC-08b）。
4. `decodeAudioData` が対応しないコーデック（一部 mov/HEVC 音声）は映像のみモードに縮退する。
