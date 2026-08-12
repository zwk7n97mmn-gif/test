import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getAudioContext, resumeAudioContext } from '../lib/audio/decode';
import { canvasSize } from '../lib/project/types';
import { effectiveRange, renderFrame } from '../lib/render/composer';
import { useCurrentAssets, useWorkspace } from '../state/workspace';
import { Alert, formatTime, useToast } from '../ui/primitives';
import { Timeline } from './Timeline';

/**
 * 合成結果のライブプレビュー。
 * 描画は renderFrame（時刻の純関数）に委ねているため、書き出し結果と絵が一致する。
 */
export function PreviewStage() {
  const { project, getAudioBuffer } = useWorkspace();
  const { clip, audio, analysis } = useCurrentAssets();
  const toast = useToast();

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const timeRef = useRef(0);
  const [displayTime, setDisplayTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [emptyReason, setEmptyReason] = useState<string | null>(null);

  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  const clockRef = useRef<{ kind: 'audio' | 'wall'; base: number; startedAt: number } | null>(null);

  const range = useMemo(
    () => (project ? effectiveRange(project, analysis, clip) : { start: 0, end: 5 }),
    [project, analysis, clip],
  );
  const duration = analysis?.duration ?? clip?.duration ?? 5;
  const size = canvasSize(project?.canvas.presetId ?? 'vertical');

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
        // 再生中のシークは一度止めてから再開する
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

  // 描画ループ（常時回し、再生中のみ時間を進める）
  useEffect(() => {
    let rafId = 0;
    let lastDisplay = -1;

    const loop = () => {
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext('2d', { alpha: false });
      if (canvas && ctx && project) {
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
        const reason =
          result.emptyReason === 'no-motion'
            ? 'モーションが未選択です。「モーション」タブで動画から抽出してください。'
            : result.emptyReason === 'no-audio'
              ? '音源が未選択です。「音源」タブで読み込むとビート同期が有効になります。'
              : null;
        setEmptyReason((prev) => (prev === reason ? prev : reason));

        const rounded = Math.round(timeRef.current * 10);
        if (rounded !== lastDisplay) {
          lastDisplay = rounded;
          setDisplayTime(timeRef.current);
        }
      }
      rafId = requestAnimationFrame(loop);
    };

    rafId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafId);
  }, [project, clip, analysis, range.end, stopAudio]);

  useEffect(() => () => stopAudio(), [stopAudio]);

  // スペースキーで再生/停止（入力欄にフォーカスがあるときは無効）
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== 'Space') return;
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(target.tagName)) return;
      event.preventDefault();
      void play();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [play]);

  if (!project) return null;

  const aspect = size.width / size.height;
  const previewHeight = Math.min(520, window.innerHeight * 0.6);

  return (
    <section className="stage" aria-label="プレビュー">
      <div className="preview-frame" style={{ width: previewHeight * aspect, maxWidth: '100%' }}>
        <canvas
          ref={canvasRef}
          width={size.width}
          height={size.height}
          style={{ width: '100%', height: 'auto' }}
          role="img"
          aria-label={`プレビュー: ${project.name}。現在 ${formatTime(displayTime)}`}
        />
      </div>

      {emptyReason && (
        <div style={{ width: '100%' }}>
          <Alert kind="info">{emptyReason}</Alert>
        </div>
      )}

      <div className="transport">
        <button type="button" className="btn btn-primary" onClick={() => void play()} aria-pressed={playing}>
          {playing ? '⏸ 一時停止' : '▶ 再生'}
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => seek(range.start)}
          aria-label="先頭に戻る"
        >
          ⏮ 先頭
        </button>
        <span className="time-display" aria-live="off">
          {formatTime(displayTime)} / {formatTime(duration)}
        </span>
      </div>

      <div style={{ width: '100%' }}>
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
          type="range"
          min={0}
          max={Math.max(0.1, duration)}
          step={0.05}
          value={Math.min(displayTime, duration)}
          onChange={(event) => seek(Number(event.target.value))}
          aria-valuetext={`${formatTime(displayTime)} / ${formatTime(duration)}`}
        />
        <p className="field-hint">
          スペースキーで再生／一時停止、← → キーで 0.05 秒ずつ移動できます。
        </p>
      </div>
    </section>
  );
}
