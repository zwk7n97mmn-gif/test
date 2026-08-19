import test from 'node:test';
import assert from 'node:assert/strict';
import {
  UNDO_LIMIT,
  assetAnalysis,
  createPersistence,
  createProject,
  createStore,
  isAnalysisDone,
  sanitizeProject,
  serializeProject,
  speechByAsset,
} from '../src/core/project.js';

/** テスト用の素材 */
const VIDEO = {
  id: 'v1', kind: 'video', name: 'a.mp4', size: 100, type: 'video/mp4',
  duration: 30, width: 1920, height: 1080, fps: 30, hasAudio: true,
};

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, v),
    removeItem: (k) => map.delete(k),
    get size() {
      return map.size;
    },
  };
}

test('createProject は妥当な初期値を持つ', () => {
  const project = createProject();
  assert.deepEqual(project.assets, []);
  assert.equal(project.media, null);
  assert.deepEqual(project.clips, []);
  assert.deepEqual(project.subtitles, []);
  assert.equal(project.analysis.done, false);
  assert.deepEqual(project.analysis.byAsset, {});
  assert.equal(project.output.aspect, 'source');
  assert.equal(project.imageDefaults.durationSec, 3);
  assert.equal(project.stt.providerId, 'vad');
});

test('AC-10: 壊れた入力でも例外を投げず既定値で埋める', () => {
  assert.doesNotThrow(() => sanitizeProject(null));
  assert.doesNotThrow(() => sanitizeProject('文字列'));
  assert.doesNotThrow(() => sanitizeProject({ clips: 'クリップではない', subtitles: 42 }));
  const project = sanitizeProject({
    name: 'x'.repeat(500),
    assets: [{ duration: -5, width: 'abc' }, { ...VIDEO, fps: 9999, hasAudio: 'yes' }],
    audio: { targetDb: 999, duckDb: -999 },
    caption: { platform: '不正' },
    subtitleStyle: { maxLines: 99, position: '斜め' },
    output: { aspect: '存在しない', fit: 'ダメ', maxSize: 99999 },
  });
  assert.equal(project.name.length, 120);
  assert.equal(project.assets.length, 1, '長さ 0 の素材は捨てられる');
  assert.equal(project.assets[0].fps, 240);
  assert.equal(project.assets[0].hasAudio, false, '文字列 "yes" は true にしない');
  assert.equal(project.audio.targetDb, -6);
  assert.equal(project.audio.duckDb, -30);
  assert.equal(project.caption.platform, 'youtube');
  assert.equal(project.subtitleStyle.maxLines, 4);
  assert.equal(project.subtitleStyle.position, 'bottom');
  assert.equal(project.output.aspect, 'source');
  assert.equal(project.output.fit, 'contain');
  assert.equal(project.output.maxSize, 3840);
});

test('v2 以前のプロジェクト（media 単体）を素材配列へ移行する', () => {
  const project = sanitizeProject({
    media: { name: 'old.mp4', duration: 20, width: 1280, height: 720, fps: 30, hasAudio: true },
    clips: [{ start: 0, end: 10, speed: 1, enabled: true }],
    subtitles: [{ id: 'c1', start: 1, end: 2, text: '旧字幕' }],
    analysis: { done: true, speech: [{ start: 1, end: 2 }], envelope: { hopSec: 0.01, db: [-30] } },
  });
  assert.equal(project.assets.length, 1);
  assert.equal(project.assets[0].kind, 'video');
  assert.equal(project.assets[0].duration, 20);
  assert.equal(project.media.duration, 20, 'media は代表素材のミラーとして残る');

  const assetId = project.assets[0].id;
  assert.equal(project.clips[0].assetId, assetId, 'クリップが素材へ紐付く');
  assert.equal(project.subtitles[0].assetId, assetId, '字幕が素材へ紐付く');
  assert.deepEqual(assetAnalysis(project, assetId).speech, [{ start: 1, end: 2, score: 0 }]);
  assert.equal(isAnalysisDone(project), true);
});

test('assets が空配列なら media ミラーから素材を復活させない', () => {
  // 最後の素材を削除した直後の状態。旧形式への移行は
  // 「assets キーが無い」ときだけで、空配列は「素材ゼロ」として扱う。
  const project = sanitizeProject({
    assets: [],
    media: { name: 'old.mp4', duration: 20, width: 1280, height: 720, fps: 30, hasAudio: true },
    clips: [],
  });
  assert.equal(project.assets.length, 0);
  assert.equal(project.media, null);
  assert.equal(project.clips.length, 0);
});

test('画像素材は表示秒数が範囲内へ丸められる', () => {
  const project = sanitizeProject({
    assets: [
      { id: 'i1', kind: 'image', name: 'a.png', width: 1000, height: 1000, duration: 999 },
      { id: 'i2', kind: 'image', name: 'b.png', width: 800, height: 600 },
    ],
  });
  assert.equal(project.assets[0].duration, 30, '上限でクランプ');
  assert.equal(project.assets[1].duration, 3, '既定 3 秒');
  assert.equal(project.assets[0].hasAudio, false);
});

test('素材が複数あるとき、クリップが無ければ素材ぶんの初期タイムラインを作る', () => {
  const project = sanitizeProject({
    assets: [VIDEO, { id: 'i1', kind: 'image', name: 'p.png', width: 800, height: 600 }],
  });
  assert.equal(project.clips.length, 2);
  assert.deepEqual(project.clips.map((c) => c.assetId), ['v1', 'i1']);
  assert.equal(project.clips[1].end, 3);
});

test('sanitizeProject は素材長を超える字幕・クリップを丸める', () => {
  const project = sanitizeProject({
    assets: [{ ...VIDEO, duration: 10 }],
    clips: [{ assetId: 'v1', start: 0, end: 50, speed: 1, enabled: true }],
    subtitles: [{ assetId: 'v1', start: 5, end: 50, text: 'a' }],
  });
  assert.equal(project.clips[0].end, 10);
  assert.equal(project.subtitles[0].end, 10);
});

test('AC-12: commit / undo / redo が動作する', () => {
  const store = createStore(createProject('テスト'));
  assert.equal(store.canUndo(), false);
  store.commit((draft) => {
    draft.name = '第一段階';
  });
  store.commit((draft) => {
    draft.name = '第二段階';
  });
  assert.equal(store.getState().name, '第二段階');
  assert.equal(store.undo(), true);
  assert.equal(store.getState().name, '第一段階');
  assert.equal(store.undo(), true);
  assert.equal(store.getState().name, 'テスト');
  assert.equal(store.undo(), false);
  assert.equal(store.redo(), true);
  assert.equal(store.getState().name, '第一段階');
});

test('history:false の変更は履歴を積まない', () => {
  const store = createStore(createProject());
  store.commit((draft) => {
    draft.name = 'A';
  }, { history: false });
  assert.equal(store.canUndo(), false);
  assert.equal(store.getState().name, 'A');
});

test('新しい変更は redo 履歴を破棄する', () => {
  const store = createStore(createProject());
  store.commit((d) => { d.name = 'A'; });
  store.undo();
  store.commit((d) => { d.name = 'B'; });
  assert.equal(store.canRedo(), false);
});

test(`履歴は ${UNDO_LIMIT} 段で打ち切られる`, () => {
  const store = createStore(createProject());
  for (let i = 0; i < UNDO_LIMIT + 20; i += 1) {
    store.commit((draft) => {
      draft.name = `段階${i}`;
    });
  }
  let count = 0;
  while (store.undo()) count += 1;
  assert.equal(count, UNDO_LIMIT);
});

test('購読者は変更を受け取り、1 つが失敗しても他へ波及しない', () => {
  const store = createStore(createProject());
  const seen = [];
  store.subscribe(() => {
    throw new Error('意図的な失敗');
  });
  store.subscribe((state) => seen.push(state.name));
  store.commit((draft) => {
    draft.name = '通知';
  });
  assert.deepEqual(seen, ['通知']);
});

test('unsubscribe が機能する', () => {
  const store = createStore(createProject());
  let calls = 0;
  const off = store.subscribe(() => { calls += 1; });
  store.commit((d) => { d.name = 'a'; });
  off();
  store.commit((d) => { d.name = 'b'; });
  assert.equal(calls, 1);
});

test('AC-12: 保存と復元が往復する', () => {
  const storage = memoryStorage();
  const persistence = createPersistence(storage);
  const store = createStore(createProject('保存テスト'));
  store.commit((draft) => {
    draft.assets = [VIDEO];
    draft.subtitles = [{ id: 'c1', assetId: 'v1', start: 1, end: 2, text: 'テスト' }];
  });
  assert.equal(persistence.save(store.getState()).ok, true);
  const loaded = persistence.load();
  assert.equal(loaded.ok, true);
  assert.equal(loaded.value.name, '保存テスト');
  assert.equal(loaded.value.subtitles[0].text, 'テスト');
  assert.equal(loaded.value.assets[0].duration, 30);
});

test('保存できない環境でも例外にならない', () => {
  const persistence = createPersistence(null);
  assert.equal(persistence.available, false);
  assert.equal(persistence.save(createProject()).ok, false);
  assert.equal(persistence.load().ok, false);
  assert.doesNotThrow(() => persistence.clear());
});

test('保存失敗（容量超過）はエラーとして返る', () => {
  const persistence = createPersistence({
    setItem() {
      const error = new Error('quota');
      error.name = 'QuotaExceededError';
      throw error;
    },
    getItem: () => 'not json',
    removeItem() {},
  });
  const result = persistence.save(createProject());
  assert.equal(result.ok, false);
  assert.equal(result.error.name, 'QuotaExceededError');
  assert.equal(persistence.load().ok, false);
});

test('serializeProject は巨大な包絡を素材ごとに間引く', () => {
  const project = createProject();
  project.assets = [{ ...VIDEO, duration: 600 }];
  project.analysis = {
    done: true,
    byAsset: {
      v1: {
        done: true,
        envelope: { hopSec: 0.01, db: new Array(60000).fill(-30) },
        speech: [], scenes: [], frames: [],
        loudness: { integratedDb: -20, peakDb: -3, noiseFloorDb: -60 },
        warnings: [],
      },
    },
  };
  const serialized = serializeProject(project);
  const envelope = serialized.analysis.byAsset.v1.envelope;
  assert.ok(envelope.db.length <= 20000);
  assert.ok(envelope.hopSec > 0.01);
  assert.ok(JSON.stringify(serialized).length < 2_000_000);
});

test('AC-10: 長尺素材でも編集操作が高速に完了する（解析結果を複製しない）', () => {
  const store = createStore(createProject());
  store.commit((draft) => {
    draft.assets = [{ ...VIDEO, id: 'long', name: 'long.mp4', duration: 3600 }];
    // 1 時間素材相当: 10ms ホップで 36 万フレーム
    draft.analysis = {
      done: true,
      byAsset: {
        long: {
          done: true,
          envelope: { hopSec: 0.01, db: new Array(360000).fill(-32) },
          speech: [{ start: 0, end: 3600 }],
          scenes: [{ start: 0, end: 3600, score: 0 }],
          frames: Array.from({ length: 14400 }, (_, i) => ({ t: i * 0.25, score: 0.5, sharp: 0.5, contrast: 0.5, colorful: 0.5, exposure: 0.5 })),
          loudness: { integratedDb: -20, peakDb: -3, noiseFloorDb: -60 },
          warnings: [],
        },
      },
    };
  });

  const start = Date.now();
  for (let i = 0; i < 30; i += 1) {
    store.commit((draft) => {
      draft.thumbnail.title = `見出し${i}`;
    }, { history: false });
  }
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 500, `30 回の編集に ${elapsed}ms かかりました（入力遅延の原因になります）`);
  assert.equal(store.getState().analysis.byAsset.long.envelope.db.length, 360000, '解析結果が失われていない');
});

test('外部データの取り込みでは解析結果も完全に検証する', () => {
  const project = sanitizeProject({
    assets: [{ ...VIDEO, duration: 10 }],
    analysis: {
      done: true,
      byAsset: {
        v1: {
          done: true,
          envelope: { hopSec: 'ダメ', db: ['x', 1] },
          speech: [{ start: -3, end: 999 }],
          scenes: 'not-array',
          frames: [{ t: 999, sharp: 5 }],
          loudness: { integratedDb: 'abc' },
          warnings: 'ダメ',
        },
      },
    },
  });
  const analysis = assetAnalysis(project, 'v1');
  assert.equal(analysis.envelope.hopSec, 0.01);
  assert.deepEqual(analysis.envelope.db, [-100, 1]);
  assert.deepEqual(analysis.speech, [{ start: 0, end: 10, score: 0 }]);
  assert.deepEqual(analysis.scenes, []);
  assert.equal(analysis.frames[0].t, 10);
  assert.equal(analysis.frames[0].sharp, 1);
  assert.equal(analysis.loudness.integratedDb, -70);
  assert.deepEqual(analysis.warnings, []);
  assert.deepEqual(speechByAsset(project), { v1: [{ start: 0, end: 10, score: 0 }] });
});

test('replace は履歴をクリアする', () => {
  const store = createStore(createProject());
  store.commit((d) => { d.name = 'A'; });
  store.replace(createProject('新規'));
  assert.equal(store.canUndo(), false);
  assert.equal(store.getState().name, '新規');
});
