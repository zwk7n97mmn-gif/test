import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getAudioContext, resumeAudioContext } from '../lib/audio/decode';
import { canvasSize } from '../lib/project/types';
import { effectiveRange, renderFrame } from '../lib/render/composer';
import { useCurrentAssets, useWorkspace } from '../state/workspace';
import { formatTime, useToast } from '../ui/primitives';
import { Timeline } from './Timeline';

/**
 * プレビューの内部解像度（縦）。スマートフォンの GPU 負荷を抑えるため
 * 出力解像度より小さく描き、CSS で拡大表示する。
 */
const PREVIEW_HEIGHT = 720;

/**
 * 合成結果のライブプレビュー。
 * 描画は renderFrame（時刻の純関数）に委ねているため、書き出し結果と絵が一致する。
 */
export function PreviewStage() {
  const { project, getAudioBuffer, renderBusy } = useWorkspace();
  const { clip, audio, analysis } = useCurrentAssets();
  const toast = useToast();

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const timeRef = useRef(0);
  const [displayTime, setDisplayTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'info' | 'error'; text: string } | null>(null);

  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  const clockRef = useRef<{ kind: 'audio' | 'wall'; base: number; startedAt: number } | null>(null);

  const range = useMemo(
    () => (project ? effectiveRange(project, analysis, clip) : { start: 0, end: 5 }),
    [project, analysis, clip],
  );
  const duration = analysis?.duration ?? clip?.duration ?? 5;

  const output = canvasSize(project?.canvas.presetId ?? 'vertical');
  const aspect = output.width / output.height;
  const previewWidth = Math.round(PREVIEW_HEIGHT * aspect);

  const stopAudio = useCallback(() => {
    const source = sourceRef.current;
    sourceRef.current = null;
    if (source) {
      try {
        source.onended = null;
        source.stop();
      } catch {
        /* 既に停止している */
      }
    }
  }, []);

  const pause = useCallback(() => {
    setPlaying(false);
    clockRef.current = null;
    stopAudio();
  }, [stopAudio]);

  const seek = useCallback(
    (time: number) => {
      const clamped = Math.min(duration, Math.max(0, time));
      timeRef.current = clamped;
      setDisplayTime(clamped);
      if (playing) {
        stopAudio();
        clockRef.current = null;
        setPlaying(false);
      }
    },
    [duration, playing, stopAudio],
  );

  const play = useCallback(async () => {
    if (playing) {
      pause();
      return;
    }
    if (timeRef.current >= range.end - 0.02) {
      timeRef.current = range.start;
    }
    const buffer = audio ? getAudioBuffer(audio.id) : null;
    try {
      if (buffer) {
        // iOS ではユーザー操作のハンドラ内で resume しないと音が出ない
        await resumeAudioContext();
        const ctx = getAudioContext();
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(ctx.destination);
        const offset = Math.min(buffer.duration - 0.01, Math.max(0, timeRef.current));
        source.start(0, offset);
        sourceRef.current = source;
        clockRef.current = { kind: 'audio', base: timeRef.current, startedAt: ctx.currentTime };
      } else {
        clockRef.current = { kind: 'wall', base: timeRef.current, startedAt: performance.now() / 1000 };
      }
      setPlaying(true);
    } catch (err) {
      toast.pushError(err, '再生を開始できませんでした。');
    }
  }, [audio, getAudioBuffer, pause, playing, range.end, range.start, toast]);

  // 書き出し中は WebGL コンテキストを譲るため、再生と描画を止める
  useEffect(() => {
    if (renderBusy && playing) pause();
  }, [renderBusy, playing, pause]);

  // 描画ループ（常時回し、再生中のみ時間を進める）
  useEffect(() => {
    let rafId = 0;
    let lastDisplay = -1;

    const loop = () => {
      rafId = requestAnimationFrame(loop);
      if (renderBusy) return;

      const canvas = canvasRef.current;
      const ctx = canvas?.getContext('2d', { alpha: false });
      if (!canvas || !ctx || !project) return;

      const clock = clockRef.current;
      if (clock) {
        const now = clock.kind === 'audio' ? getAudioContext().currentTime : performance.now() / 1000;
        const next = clock.base + (now - clock.startedAt);
        if (next >= range.end) {
          timeRef.current = range.end;
          clockRef.current = null;
          stopAudio();
          setPlaying(false);
        } else {
          timeRef.current = next;
        }
      }

      const result = renderFrame(ctx, timeRef.current, { project, clip, analysis });
      const next: typeof notice = result.error
        ? { kind: 'error', text: result.error }
        : result.emptyReason === 'no-motion'
          ? { kind: 'info', text: '「モーション」で動画から動きを取り込むと、ここに表示されます。' }
          : result.emptyReason === 'no-audio'
            ? { kind: 'info', text: '「音源」で曲を読み込むとビートに同期します。' }
            : null;
      setNotice((prev) => (prev?.text === next?.text ? prev : next));

      const rounded = Math.round(timeRef.current * 10);
      if (rounded !== lastDisplay) {
        lastDisplay = rounded;
        setDisplayTime(timeRef.current);
      }
    };

    rafId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafId);
  }, [project, clip, analysis, range.end, stopAudio, renderBusy]);

  useEffect(() => () => stopAudio(), [stopAudio]);

  if (!project) return null;

  return (
    <section className="stage" aria-label="プレビュー">
      <div className="preview-frame" style={{ aspectRatio: `${output.width} / ${output.height}` }}>
        <canvas
          ref={canvasRef}
          width={previewWidth}
          height={PREVIEW_HEIGHT}
          role="img"
          aria-label={`プレビュー: ${project.name}。現在 ${formatTime(displayTime)}`}
        />
      </div>

      {notice && (
        <p
          className={notice.kind === 'error' ? 'stage-note is-error' : 'stage-note'}
          role={notice.kind === 'error' ? 'alert' : 'status'}
        >
          {notice.text}
        </p>
      )}

      <div className="transport">
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void play()}
          aria-pressed={playing}
          disabled={renderBusy}
        >
          {playing ? '⏸ 停止' : '▶ 再生'}
        </button>
        <button type="button" className="btn" onClick={() => seek(range.start)} aria-label="先頭に戻る">
          ⏮
        </button>
        <span className="time-display">
          {formatTime(displayTime)} / {formatTime(duration)}
        </span>
      </div>

      <div className="timeline-wrap">
        <Timeline
          analysis={analysis}
          duration={duration}
          time={displayTime}
          range={project.range}
          onSeek={seek}
        />
        <label htmlFor="preview-seek" className="visually-hidden">
          再生位置（秒）
        </label>
        <input
          id="preview-seek"
          className="timeline-range"
          type="range"
          min={0}
          max={Math.max(0.1, duration)}
          step={0.05}
          value={Math.min(displayTime, duration)}
          onChange={(event) => seek(Number(event.target.value))}
          aria-valuetext={`${formatTime(displayTime)} / ${formatTime(duration)}`}
        />
      </div>
    </section>
  );
}
