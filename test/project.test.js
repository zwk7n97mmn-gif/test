import test from 'node:test';
import assert from 'node:assert/strict';
import {
  UNDO_LIMIT,
  createPersistence,
  createProject,
  createStore,
  sanitizeProject,
  serializeProject,
} from '../src/core/project.js';

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
  assert.equal(project.media, null);
  assert.deepEqual(project.clips, []);
  assert.deepEqual(project.subtitles, []);
  assert.equal(project.analysis.done, false);
  assert.equal(project.stt.providerId, 'vad');
});

test('AC-10: 壊れた入力でも例外を投げず既定値で埋める', () => {
  assert.doesNotThrow(() => sanitizeProject(null));
  assert.doesNotThrow(() => sanitizeProject('文字列'));
  assert.doesNotThrow(() => sanitizeProject({ clips: 'クリップではない', subtitles: 42 }));
  const project = sanitizeProject({
    name: 'x'.repeat(500),
    media: { duration: -5, width: 'abc', fps: 9999, hasAudio: 'yes' },
    audio: { targetDb: 999, duckDb: -999 },
    caption: { platform: '不正' },
    subtitleStyle: { maxLines: 99, position: '斜め' },
  });
  assert.equal(project.name.length, 120);
  assert.equal(project.media.duration, 0);
  assert.equal(project.media.width, 0);
  assert.equal(project.media.fps, 240);
  assert.equal(project.media.hasAudio, false);
  assert.equal(project.audio.targetDb, -6);
  assert.equal(project.audio.duckDb, -30);
  assert.equal(project.caption.platform, 'youtube');
  assert.equal(project.subtitleStyle.maxLines, 4);
  assert.equal(project.subtitleStyle.position, 'bottom');
});

test('sanitizeProject は素材長を超える字幕・クリップを丸める', () => {
  const project = sanitizeProject({
    media: { duration: 10, width: 1920, height: 1080 },
    clips: [{ start: 0, end: 50, speed: 1, enabled: true }],
    subtitles: [{ start: 5, end: 50, text: 'a' }],
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
    draft.media = { name: 'a.mp4', size: 100, type: 'video/mp4', duration: 30, width: 1920, height: 1080, fps: 30, hasAudio: true };
    draft.subtitles = [{ id: 'c1', start: 1, end: 2, text: 'テスト' }];
  });
  assert.equal(persistence.save(store.getState()).ok, true);
  const loaded = persistence.load();
  assert.equal(loaded.ok, true);
  assert.equal(loaded.value.name, '保存テスト');
  assert.equal(loaded.value.subtitles[0].text, 'テスト');
  assert.equal(loaded.value.media.duration, 30);
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

test('serializeProject は巨大な包絡を間引く', () => {
  const project = createProject();
  project.media = { name: 'a', size: 1, type: 'video/mp4', duration: 600, width: 1280, height: 720, fps: 30, hasAudio: true };
  project.analysis.envelope = { hopSec: 0.01, db: new Array(60000).fill(-30) };
  const serialized = serializeProject(project);
  assert.ok(serialized.analysis.envelope.db.length <= 20000);
  assert.ok(serialized.analysis.envelope.hopSec > 0.01);
  assert.ok(JSON.stringify(serialized).length < 2_000_000);
});

test('AC-10: 長尺素材でも編集操作が高速に完了する（解析結果を複製しない）', () => {
  const store = createStore(createProject());
  store.commit((draft) => {
    draft.media = { name: 'long.mp4', size: 1, type: 'video/mp4', duration: 3600, width: 1920, height: 1080, fps: 30, hasAudio: true };
    // 1 時間素材相当: 10ms ホップで 36 万フレーム
    draft.analysis = {
      done: true,
      envelope: { hopSec: 0.01, db: new Array(360000).fill(-32) },
      speech: [{ start: 0, end: 3600 }],
      scenes: [{ start: 0, end: 3600, score: 0 }],
      frames: Array.from({ length: 14400 }, (_, i) => ({ t: i * 0.25, score: 0.5, sharp: 0.5, contrast: 0.5, colorful: 0.5, exposure: 0.5 })),
      loudness: { integratedDb: -20, peakDb: -3, noiseFloorDb: -60 },
      warnings: [],
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
  assert.equal(store.getState().analysis.envelope.db.length, 360000, '解析結果が失われていない');
});

test('外部データの取り込みでは解析結果も完全に検証する', () => {
  const project = sanitizeProject({
    media: { duration: 10 },
    analysis: {
      done: true,
      envelope: { hopSec: 'ダメ', db: ['x', 1] },
      speech: [{ start: -3, end: 999 }],
      scenes: 'not-array',
      frames: [{ t: 999, sharp: 5 }],
      loudness: { integratedDb: 'abc' },
      warnings: 'ダメ',
    },
  });
  assert.equal(project.analysis.envelope.hopSec, 0.01);
  assert.deepEqual(project.analysis.envelope.db, [-100, 1]);
  assert.deepEqual(project.analysis.speech, [{ start: 0, end: 10, score: 0 }]);
  assert.deepEqual(project.analysis.scenes, []);
  assert.equal(project.analysis.frames[0].t, 10);
  assert.equal(project.analysis.frames[0].sharp, 1);
  assert.equal(project.analysis.loudness.integratedDb, -70);
  assert.deepEqual(project.analysis.warnings, []);
});

test('replace は履歴をクリアする', () => {
  const store = createStore(createProject());
  store.commit((d) => { d.name = 'A'; });
  store.replace(createProject('新規'));
  assert.equal(store.canUndo(), false);
  assert.equal(store.getState().name, '新規');
});
