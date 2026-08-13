import { useEffect, useRef } from 'react';
import type { AudioAnalysis, SectionKind } from '../lib/audio/types';
import { withAlpha } from '../lib/util/color';

const SECTION_COLORS: Record<SectionKind, string> = {
  intro: '#5b6ea8',
  verse: '#4e7f8e',
  build: '#9a7a3c',
  hook: '#c14a86',
  break: '#5a5570',
  outro: '#4a5a6a',
};

export const SECTION_LABELS: Record<SectionKind, string> = {
  intro: 'イントロ',
  verse: 'Aメロ/Bメロ',
  build: 'ビルド',
  hook: 'サビ',
  break: 'ブレイク',
  outro: 'アウトロ',
};

interface TimelineProps {
  analysis: AudioAnalysis | null;
  duration: number;
  time: number;
  range: { start: number; end: number } | null;
  onSeek: (time: number) => void;
}

/**
 * 波形・区間・ビートを重ねた時間軸表示。
 * canvas は装飾（aria-hidden）で、操作は隣接する range 入力が担当する。
 */
export function Timeline({ analysis, duration, time, range, onSeek }: TimelineProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const parentWidth = canvas.parentElement?.clientWidth ?? 600;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const width = Math.max(200, parentWidth);
    const height = canvas.parentElement?.clientHeight || 62;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = '100%';
    canvas.style.height = '100%';

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const total = duration > 0 ? duration : 1;
    const toX = (t: number) => (t / total) * width;

    // 区間の帯
    if (analysis && analysis.sections.length > 0) {
      for (const section of analysis.sections) {
        const x = toX(section.start);
        const w = Math.max(1, toX(section.end) - x);
        ctx.fillStyle = withAlpha(SECTION_COLORS[section.kind], section.kind === 'hook' ? 0.85 : 0.5);
        ctx.fillRect(x, 0, w, 13);
        if (w > 48) {
          ctx.fillStyle = '#ffffff';
          ctx.font = '600 10px system-ui, sans-serif';
          ctx.textBaseline = 'middle';
          ctx.fillText(SECTION_LABELS[section.kind], x + 4, 7);
        }
      }
    }

    // 波形
    const waveTop = 18;
    const waveHeight = height - waveTop - 14;
    const waveform = analysis?.waveform;
    ctx.fillStyle = '#8f86b5';
    if (waveform && waveform.length > 0) {
      for (let x = 0; x < width; x++) {
        const index = Math.min(waveform.length - 1, Math.floor((x / width) * waveform.length));
        const amplitude = waveform[index];
        const h = Math.max(1, amplitude * waveHeight);
        ctx.fillRect(x, waveTop + (waveHeight - h) / 2, 1, h);
      }
    } else {
      ctx.fillStyle = '#5c5675';
      ctx.fillRect(0, waveTop + waveHeight / 2, width, 1);
    }

    // ビート（小節頭は強調）
    if (analysis) {
      for (const beat of analysis.beats) {
        const x = toX(beat.time);
        const isDownbeat = beat.indexInBar === 0;
        ctx.fillStyle = isDownbeat ? 'rgba(255, 143, 192, 0.95)' : 'rgba(255, 255, 255, 0.28)';
        ctx.fillRect(x, height - 12, isDownbeat ? 2 : 1, isDownbeat ? 11 : 6);
      }
    }

    // 書き出し範囲外を暗くする
    if (range) {
      ctx.fillStyle = 'rgba(8, 6, 14, 0.62)';
      ctx.fillRect(0, 0, toX(range.start), height);
      ctx.fillRect(toX(range.end), 0, width - toX(range.end), height);
      ctx.strokeStyle = '#ffd479';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(toX(range.start), 0);
      ctx.lineTo(toX(range.start), height);
      ctx.moveTo(toX(range.end), 0);
      ctx.lineTo(toX(range.end), height);
      ctx.stroke();
    }

    // 再生ヘッド
    const playX = toX(Math.min(total, Math.max(0, time)));
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(playX, 0);
    ctx.lineTo(playX, height);
    ctx.stroke();
  }, [analysis, duration, time, range]);

  const handlePointer = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width === 0) return;
    const ratio = (event.clientX - rect.left) / rect.width;
    onSeek(Math.min(duration, Math.max(0, ratio * duration)));
  };

  return (
    <canvas
      ref={canvasRef}
      className="timeline"
      aria-hidden="true"
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        handlePointer(event);
      }}
      onPointerMove={(event) => {
        if (event.buttons === 1) handlePointer(event);
      }}
    />
  );
}
