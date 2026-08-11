/**
 * タイムライン表示（波形・発話区間・シーン・クリップ・字幕）。
 * 横軸は「ソース素材の時刻」。削除された区間も見えるため、自動編集の結果を確認できる。
 * キーボード操作のため role="slider" を実装する。
 */

import { COLORS } from '../core/tokens.js';
import { layoutClips, sourceToTimeline, timelineToSource } from '../core/autoedit.js';
import { clamp, formatTime, speakableTime } from '../core/util.js';
import { h } from './dom.js';

const ROWS = { wave: 0.42, clips: 0.2, speech: 0.12, scenes: 0.1, cues: 0.16 };

export function createTimeline({ getProject, onSeek }) {
  const canvas = h('canvas.timeline__canvas');
  const container = h('div.timeline', {
    attrs: {
      role: 'slider',
      tabindex: '0',
      'aria-label': 'タイムライン（左右キーで移動、Home / End で先頭・末尾）',
      'aria-valuemin': '0',
      'aria-valuemax': '0',
      'aria-valuenow': '0',
      'aria-valuetext': '0秒',
    },
  }, [canvas]);

  let playheadSource = 0;
  let dragging = false;
  let rafId = null;

  const project = () => getProject();

  function seekToClientX(clientX) {
    const rect = canvas.getBoundingClientRect();
    const duration = project().media?.duration || 0;
    if (duration <= 0) return;
    const ratio = clamp((clientX - rect.left) / rect.width, 0, 1);
    const sourceTime = ratio * duration;
    const { timelineTime } = sourceToTimeline(project().clips, sourceTime);
    onSeek(timelineTime);
  }

  container.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    dragging = true;
    container.setPointerCapture(event.pointerId);
    container.focus();
    seekToClientX(event.clientX);
  });
  container.addEventListener('pointermove', (event) => {
    if (dragging) seekToClientX(event.clientX);
  });
  const endDrag = (event) => {
    if (!dragging) return;
    dragging = false;
    try {
      container.releasePointerCapture(event.pointerId);
    } catch {
      /* 既に解放済み */
    }
  };
  container.addEventListener('pointerup', endDrag);
  container.addEventListener('pointercancel', endDrag);

  container.addEventListener('keydown', (event) => {
    const p = project();
    const total = p.clips.length ? layoutClips(p.clips).at(-1)?.timelineEnd || 0 : 0;
    if (total <= 0) return;
    const current = sourceToTimeline(p.clips, playheadSource).timelineTime;
    const fine = 1 / (p.media?.fps || 30);
    let next = null;
    switch (event.key) {
      case 'ArrowLeft': next = current - (event.shiftKey ? 1 : fine); break;
      case 'ArrowRight': next = current + (event.shiftKey ? 1 : fine); break;
      case 'PageDown': next = current - 10; break;
      case 'PageUp': next = current + 10; break;
      case 'Home': next = 0; break;
      case 'End': next = total; break;
      default: return;
    }
    event.preventDefault();
    onSeek(clamp(next, 0, total));
  });

  const resizeObserver = new ResizeObserver(() => invalidate());
  resizeObserver.observe(container);

  function invalidate() {
    if (rafId !== null) return;
    rafId = requestAnimationFrame(() => {
      rafId = null;
      draw();
    });
  }

  /** @param {number} timelineTime */
  function setPlayhead(timelineTime) {
    const p = project();
    const mapped = timelineToSource(p.clips, timelineTime);
    playheadSource = mapped ? mapped.sourceTime : 0;
    const laid = layoutClips(p.clips);
    const total = laid.length ? laid.at(-1).timelineEnd : 0;
    container.setAttribute('aria-valuemax', total.toFixed(2));
    container.setAttribute('aria-valuenow', timelineTime.toFixed(2));
    container.setAttribute('aria-valuetext', `${speakableTime(timelineTime)} / 全体 ${speakableTime(total)}`);
    invalidate();
  }

  function draw() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = container.getBoundingClientRect();
    const width = Math.max(1, Math.floor(rect.width));
    const height = Math.max(80, Math.floor(rect.height));
    if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const p = project();
    const duration = p.media?.duration || 0;
    ctx.fillStyle = COLORS.surface;
    ctx.fillRect(0, 0, width, height);

    if (duration <= 0) {
      ctx.fillStyle = COLORS.textMuted;
      ctx.font = '13px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('素材を読み込むとタイムラインが表示されます', width / 2, height / 2);
      return;
    }

    const x = (t) => (t / duration) * width;
    let y = 0;
    const rowHeight = (key) => Math.round(height * ROWS[key]);

    // 波形（RMS 包絡）
    const waveH = rowHeight('wave');
    drawWaveform(ctx, p, width, y, waveH);
    y += waveH;

    // クリップ（採用区間 / 削除区間）
    const clipH = rowHeight('clips');
    ctx.fillStyle = '#22303c';
    ctx.fillRect(0, y, width, clipH);
    for (const clip of layoutClips(p.clips)) {
      ctx.fillStyle = clip.speed > 1 ? COLORS.warning : COLORS.accent;
      ctx.globalAlpha = 0.85;
      ctx.fillRect(x(clip.start), y + 2, Math.max(1, x(clip.end) - x(clip.start)), clipH - 4);
      ctx.globalAlpha = 1;
    }
    y += clipH;

    // 発話区間
    const speechH = rowHeight('speech');
    for (const seg of p.analysis.speech) {
      ctx.fillStyle = COLORS.success;
      ctx.fillRect(x(seg.start), y + 1, Math.max(1, x(seg.end) - x(seg.start)), speechH - 2);
    }
    y += speechH;

    // シーン境界
    const sceneH = rowHeight('scenes');
    ctx.strokeStyle = COLORS.textMuted;
    ctx.lineWidth = 1;
    for (const scene of p.analysis.scenes) {
      if (scene.start <= 0) continue;
      ctx.beginPath();
      ctx.moveTo(Math.round(x(scene.start)) + 0.5, y);
      ctx.lineTo(Math.round(x(scene.start)) + 0.5, y + sceneH);
      ctx.stroke();
    }
    y += sceneH;

    // 字幕
    const cueH = Math.max(6, height - y - 1);
    for (const cue of p.subtitles) {
      ctx.fillStyle = cue.needsText ? COLORS.warning : COLORS.accent;
      ctx.globalAlpha = cue.needsText ? 0.6 : 0.9;
      ctx.fillRect(x(cue.start), y + 1, Math.max(1, x(cue.end) - x(cue.start)), cueH - 2);
    }
    ctx.globalAlpha = 1;

    // 目盛り
    drawRuler(ctx, duration, width, height);

    // 再生ヘッド
    const px = Math.round(x(playheadSource)) + 0.5;
    ctx.strokeStyle = COLORS.focus;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(px, 0);
    ctx.lineTo(px, height);
    ctx.stroke();
  }

  function drawWaveform(ctx, p, width, top, waveH) {
    const db = p.analysis.envelope.db;
    const hop = p.analysis.envelope.hopSec || 0.01;
    ctx.fillStyle = '#1b232b';
    ctx.fillRect(0, top, width, waveH);
    if (!db.length) {
      ctx.fillStyle = COLORS.textMuted;
      ctx.font = '12px system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(p.analysis.done ? '音声トラックなし' : '未解析', 8, top + waveH / 2 + 4);
      return;
    }
    const duration = p.media?.duration || db.length * hop;
    const mid = top + waveH / 2;
    ctx.fillStyle = COLORS.accent;
    for (let px = 0; px < width; px += 1) {
      const from = Math.floor(((px / width) * duration) / hop);
      const to = Math.max(from + 1, Math.floor((((px + 1) / width) * duration) / hop));
      let peak = -100;
      for (let i = from; i < to && i < db.length; i += 1) peak = Math.max(peak, db[i]);
      if (peak <= -100) continue;
      const amp = clamp((peak + 60) / 60, 0, 1);
      const half = (amp * waveH) / 2;
      ctx.fillRect(px, mid - half, 1, Math.max(1, half * 2));
    }
  }

  function drawRuler(ctx, duration, width, height) {
    const targets = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800];
    const step = targets.find((s) => (duration / s) * 60 < width) || 3600;
    ctx.fillStyle = COLORS.textMuted;
    ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.strokeStyle = 'rgba(167,180,194,0.25)';
    ctx.lineWidth = 1;
    for (let t = 0; t <= duration; t += step) {
      const px = Math.round((t / duration) * width) + 0.5;
      ctx.beginPath();
      ctx.moveTo(px, height - 14);
      ctx.lineTo(px, height);
      ctx.stroke();
      if (t > 0) ctx.fillText(formatTime(t), px + 3, height - 4);
    }
  }

  return {
    element: container,
    setPlayhead,
    refresh: invalidate,
    dispose() {
      resizeObserver.disconnect();
      if (rafId !== null) cancelAnimationFrame(rafId);
    },
  };
}
