import { useEffect, useRef, useState } from 'react';
import {
  MAX_CLIP_SECONDS,
  checkEngineAvailability,
  extractMotionFromVideo,
  loadVideoElement,
} from '../lib/pose/extractor';
import { mirrorClip } from '../lib/pose/normalize';
import { deserializeClip, serializeClip, type MotionClip } from '../lib/pose/types';
import { useWorkspace } from '../state/workspace';
import { Alert, EmptyState, Field, ProgressBar, formatTime, useToast } from '../ui/primitives';

const MAX_VIDEO_BYTES = 300 * 1024 * 1024;

export function MotionPanel() {
  const { clips, addClip, removeClip, project, updateProject } = useWorkspace();
  const toast = useToast();

  const [engine, setEngine] = useState<{ available: boolean; reason?: string; hint?: string } | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [videoInfo, setVideoInfo] = useState<{ duration: number; width: number; height: number } | null>(null);
  const [start, setStart] = useState(0);
  const [length, setLength] = useState(8);
  const [targetFps, setTargetFps] = useState(24);
  const [model, setModel] = useState<'lite' | 'full'>('lite');
  const [progress, setProgress] = useState<{ ratio: number; message: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const importInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void checkEngineAvailability().then((result) =>
      setEngine(result.available ? { available: true } : { available: false, reason: result.reason, hint: result.hint }),
    );
  }, []);

  const handleVideoSelected = async (selected: File) => {
    setError(null);
    setFile(null);
    setVideoInfo(null);
    if (selected.size > MAX_VIDEO_BYTES) {
      setError('動画ファイルが大きすぎます（300MB まで）。短く切り出してから読み込んでください。');
      return;
    }
    try {
      const { video, revoke } = await loadVideoElement(selected);
      setVideoInfo({ duration: video.duration, width: video.videoWidth, height: video.videoHeight });
      setStart(0);
      setLength(Math.min(MAX_CLIP_SECONDS, Math.max(1, Math.min(8, video.duration))));
      setFile(selected);
      revoke();
    } catch (err) {
      setError(err instanceof Error ? err.message : '動画を読み込めませんでした。');
      toast.pushError(err, '動画を読み込めませんでした。');
    }
  };

  const runExtraction = async () => {
    if (!file || !videoInfo) return;
    setError(null);
    const controller = new AbortController();
    abortRef.current = controller;
    setProgress({ ratio: 0, message: '準備中…' });
    try {
      const clip = await extractMotionFromVideo(file, {
        start,
        end: Math.min(videoInfo.duration, start + length),
        targetFps,
        model,
        signal: controller.signal,
        onProgress: (update) => setProgress({ ratio: update.ratio, message: update.message }),
      });
      await addClip(clip);
      updateProject({ motionClipId: clip.id });
      toast.push(
        'success',
        `モーションを抽出しました（${clip.frames.length} フレーム / 検出率 ${(clip.quality.detectionRate * 100).toFixed(0)}%）`,
      );
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        toast.push('info', '抽出を中止しました。');
      } else {
        setError(err instanceof Error ? err.message : '抽出に失敗しました。');
        toast.pushError(err, 'モーションの抽出に失敗しました。');
      }
    } finally {
      setProgress(null);
      abortRef.current = null;
    }
  };

  const exportClip = (clip: MotionClip) => {
    const json = JSON.stringify(serializeClip(clip));
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${clip.name}.motion.json`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };

  const importClip = async (selected: File) => {
    try {
      const clip = deserializeClip(JSON.parse(await selected.text()));
      await addClip(clip);
      updateProject({ motionClipId: clip.id });
      toast.push('success', `「${clip.name}」を読み込みました。`);
    } catch (err) {
      toast.pushError(err, 'モーションファイルを読み込めませんでした。');
    } finally {
      if (importInputRef.current) importInputRef.current.value = '';
    }
  };

  const maxStart = Math.max(0, (videoInfo?.duration ?? 0) - 0.5);
  const maxLength = Math.min(MAX_CLIP_SECONDS, Math.max(0.5, (videoInfo?.duration ?? MAX_CLIP_SECONDS) - start));

  return (
    <div>
      <section className="panel">
        <h2>動画からモーションを抽出</h2>
        <p className="panel-desc">
          動画に映る人物の関節位置だけを取り出して、キャラクターに適用できる形へ変換します。
          元動画の映像・人物の見た目は保存されず、出力にも一切含まれません。
        </p>

        {engine && !engine.available && (
          <Alert kind="error" title="姿勢推定エンジンを利用できません">
            {engine.reason}
            {engine.hint && <span className="toast-hint">{engine.hint}</span>}
          </Alert>
        )}

        <label className="field-label" htmlFor="video-file">
          動画ファイル（MP4 / WebM / MOV、300MB まで）
        </label>
        <input
          id="video-file"
          type="file"
          accept="video/*"
          disabled={progress !== null}
          onChange={(event) => {
            const selected = event.target.files?.[0];
            if (selected) void handleVideoSelected(selected);
          }}
        />

        {videoInfo && (
          <>
            <p className="field-hint" style={{ marginTop: 8 }}>
              読み込み済み: {videoInfo.width}×{videoInfo.height}px / 全長 {formatTime(videoInfo.duration)}
            </p>

            <div className="grid-2" style={{ marginTop: 12 }}>
              <Field label="開始位置" value={formatTime(start)}>
                {({ id }) => (
                  <input
                    id={id}
                    type="range"
                    min={0}
                    max={maxStart}
                    step={0.1}
                    value={Math.min(start, maxStart)}
                    onChange={(event) => setStart(Number(event.target.value))}
                  />
                )}
              </Field>
              <Field
                label="抽出する長さ"
                value={`${length.toFixed(1)} 秒`}
                hint={`最長 ${MAX_CLIP_SECONDS} 秒`}
              >
                {({ id }) => (
                  <input
                    id={id}
                    type="range"
                    min={0.5}
                    max={maxLength}
                    step={0.1}
                    value={Math.min(length, maxLength)}
                    onChange={(event) => setLength(Number(event.target.value))}
                  />
                )}
              </Field>
            </div>

            <div className="grid-2">
              <Field label="解析フレームレート" value={`${targetFps} fps`} hint="低いほど高速・粗くなります">
                {({ id }) => (
                  <input
                    id={id}
                    type="range"
                    min={10}
                    max={60}
                    step={1}
                    value={targetFps}
                    onChange={(event) => setTargetFps(Number(event.target.value))}
                  />
                )}
              </Field>
              <Field label="モデル" hint="full は高精度ですが処理が遅くなります">
                {({ id }) => (
                  <select id={id} value={model} onChange={(event) => setModel(event.target.value as 'lite' | 'full')}>
                    <option value="lite">lite（高速）</option>
                    <option value="full">full（高精度）</option>
                  </select>
                )}
              </Field>
            </div>

            <p className="field-hint">
              推定処理時間の目安: 約 {Math.ceil((length * targetFps * (model === 'full' ? 90 : 45)) / 1000)} 秒
            </p>

            <div className="btn-row" style={{ marginTop: 8 }}>
              <button
                type="button"
                className="btn btn-primary"
                disabled={progress !== null || engine?.available === false}
                onClick={() => void runExtraction()}
              >
                この区間からモーションを抽出
              </button>
              {progress && (
                <button type="button" className="btn" onClick={() => abortRef.current?.abort()}>
                  中止
                </button>
              )}
            </div>
          </>
        )}

        {progress && (
          <div style={{ marginTop: 12 }}>
            <ProgressBar ratio={progress.ratio} label={progress.message} />
          </div>
        )}

        {error && (
          <div style={{ marginTop: 12 }}>
            <Alert kind="error" title="抽出できませんでした">
              {error}
            </Alert>
          </div>
        )}

        <p className="legal-note">
          他者が権利を持つ動画を素材にする場合は、振り付け・映像の利用について権利者の許諾が必要になることが
          あります。公開前に必ずご確認ください。
        </p>
      </section>

      <section className="panel">
        <h2>モーションクリップ（{clips.length}）</h2>
        <div className="btn-row" style={{ marginBottom: 12 }}>
          <label className="btn" style={{ cursor: 'pointer' }}>
            JSON を読み込む
            <input
              ref={importInputRef}
              type="file"
              accept="application/json,.json"
              className="visually-hidden"
              onChange={(event) => {
                const selected = event.target.files?.[0];
                if (selected) void importClip(selected);
              }}
            />
          </label>
        </div>

        {clips.length === 0 ? (
          <EmptyState title="まだモーションがありません">
            動画から抽出するか、書き出し済みの .motion.json を読み込んでください。
          </EmptyState>
        ) : (
          <ul className="item-list">
            {clips.map((clip) => (
              <li key={clip.id} className="item" aria-current={clip.id === project?.motionClipId}>
                <div className="item-main">
                  <div className="item-title">{clip.name}</div>
                  <div className="item-meta">
                    {formatTime(clip.duration)} ／ {clip.frames.length}f ／ {clip.fps}fps ／ 検出率{' '}
                    {(clip.quality.detectionRate * 100).toFixed(0)}% ／ 信頼度{' '}
                    {(clip.quality.meanConfidence * 100).toFixed(0)}%
                  </div>
                  {clip.quality.warnings.length > 0 && (
                    <div className="item-meta" style={{ color: 'var(--warning)' }}>
                      ⚠ {clip.quality.warnings[0]}
                    </div>
                  )}
                </div>
                <div className="btn-row">
                  <button
                    type="button"
                    className="btn"
                    disabled={clip.id === project?.motionClipId}
                    onClick={() => updateProject({ motionClipId: clip.id })}
                  >
                    {clip.id === project?.motionClipId ? '使用中' : '使う'}
                  </button>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => void addClip(mirrorClip(clip)).catch((err) => toast.pushError(err))}
                    aria-label={`${clip.name} を左右反転して複製`}
                  >
                    反転複製
                  </button>
                  <button type="button" className="btn" onClick={() => exportClip(clip)} aria-label={`${clip.name} を書き出し`}>
                    保存
                  </button>
                  <button
                    type="button"
                    className="btn btn-danger"
                    onClick={() => {
                      if (window.confirm(`「${clip.name}」を削除します。よろしいですか？`)) {
                        void removeClip(clip.id).catch((err) => toast.pushError(err));
                      }
                    }}
                    aria-label={`${clip.name} を削除`}
                  >
                    削除
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
