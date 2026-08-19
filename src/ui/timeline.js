/**
 * タイムライン表示（波形・発話区間・シーン・クリップ・字幕）。
 * 横軸は「ソース素材の時刻」。削除された区間も見えるため、自動編集の結果を確認できる。
 * キーボード操作のため role="slider" を実装する。
 */

import { COLORS } from '../core/tokens.js';
import { layoutClips, sourceToTimeline, timelineToSource } from '../core/autoedit.js';
import { assetAnalysis } from '../core/project.js';
import { clamp, formatTime, speakableTime } from '../core/util.js';
import { h } from './dom.js';

/**
 * 横軸は「素材を順に並べた時刻」。
 * 素材ごとの区間を連結した座標にすることで、複数素材でも
 * 「どこが採用され、どこが削られたか」が一目で分かる。
 */
function buildAxis(assets) {
  let offset = 0;
  const map = new Map();
  for (const asset of assets || []) {
    map.set(asset.id, { offset, duration: asset.duration, asset });
    offset += asset.duration;
  }
  return { map, total: offset };
}

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
    const p = project();
    const axis = buildAxis(p.assets);
    if (axis.total <= 0) return;
    const rect = canvas.getBoundingClientRect();
    const ratio = clamp((clientX - rect.left) / rect.width, 0, 1);
    const absolute = ratio * axis.total;
    // どの素材の何秒を指しているかを求める
    for (const [assetId, entry] of axis.map) {
      if (absolute <= entry.offset + entry.duration || assetId === [...axis.map.keys()].at(-1)) {
        const sourceTime = clamp(absolute - entry.offset, 0, entry.duration);
        onSeek(sourceToTimeline(p.clips, sourceTime, assetId).timelineTime);
        return;
      }
    }
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
    const axis = buildAxis(p.assets);
    playheadSource = mapped ? (axis.map.get(mapped.assetId)?.offset ?? 0) + mapped.sourceTime : 0;
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
    const axis = buildAxis(p.assets);
    ctx.fillStyle = COLORS.surface;
    ctx.fillRect(0, 0, width, height);

    if (axis.total <= 0) {
      ctx.fillStyle = COLORS.textMuted;
      ctx.font = '13px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('素材を追加するとタイムラインが表示されます', width / 2, height / 2);
      return;
    }

    /** 素材内の時刻 → 画面上の x */
    const x = (assetId, t) => (((axis.map.get(assetId)?.offset ?? 0) + t) / axis.total) * width;
    /** 連結座標 → x */
    const xAbs = (t) => (t / axis.total) * width;

    let y = 0;
    const rowHeight = (key) => Math.round(height * ROWS[key]);

    // 波形（素材ごとの RMS 包絡を並べる）
    const waveH = rowHeight('wave');
    drawWaveform(ctx, p, axis, width, y, waveH);
    y += waveH;

    // クリップ（採用区間）
    const clipH = rowHeight('clips');
    ctx.fillStyle = '#22303c';
    ctx.fillRect(0, y, width, clipH);
    for (const clip of layoutClips(p.clips)) {
      const asset = axis.map.get(clip.assetId)?.asset;
      ctx.fillStyle = asset?.kind === 'image' ? COLORS.success : (clip.speed > 1 ? COLORS.warning : COLORS.accent);
      ctx.globalAlpha = 0.85;
      const left = x(clip.assetId, clip.start);
      const right = x(clip.assetId, clip.end);
      ctx.fillRect(left, y + 2, Math.max(1, right - left), clipH - 4);
      ctx.globalAlpha = 1;
    }
    y += clipH;

    // 発話区間
    const speechH = rowHeight('speech');
    for (const asset of p.assets) {
      for (const seg of assetAnalysis(p, asset.id).speech) {
        ctx.fillStyle = COLORS.success;
        const left = x(asset.id, seg.start);
        ctx.fillRect(left, y + 1, Math.max(1, x(asset.id, seg.end) - left), speechH - 2);
      }
    }
    y += speechH;

    // シーン境界
    const sceneH = rowHeight('scenes');
    ctx.strokeStyle = COLORS.textMuted;
    ctx.lineWidth = 1;
    for (const asset of p.assets) {
      for (const scene of assetAnalysis(p, asset.id).scenes) {
        if (scene.start <= 0) continue;
        const px = Math.round(x(asset.id, scene.start)) + 0.5;
        ctx.beginPath();
        ctx.moveTo(px, y);
        ctx.lineTo(px, y + sceneH);
        ctx.stroke();
      }
    }
    y += sceneH;

    // 字幕
    const cueH = Math.max(6, height - y - 1);
    for (const cue of p.subtitles) {
      if (!axis.map.has(cue.assetId)) continue;
      ctx.fillStyle = cue.needsText ? COLORS.warning : COLORS.accent;
      ctx.globalAlpha = cue.needsText ? 0.6 : 0.9;
      const left = x(cue.assetId, cue.start);
      ctx.fillRect(left, y + 1, Math.max(1, x(cue.assetId, cue.end) - left), cueH - 2);
    }
    ctx.globalAlpha = 1;

    // 素材の境目
    ctx.strokeStyle = COLORS.text;
    ctx.globalAlpha = 0.35;
    ctx.lineWidth = 1;
    for (const entry of axis.map.values()) {
      if (entry.offset <= 0) continue;
      const px = Math.round(xAbs(entry.offset)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(px, 0);
      ctx.lineTo(px, height);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    drawRuler(ctx, axis.total, width, height);

    // 再生ヘッド
    const px = Math.round(xAbs(playheadSource)) + 0.5;
    ctx.strokeStyle = COLORS.focus;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(px, 0);
    ctx.lineTo(px, height);
    ctx.stroke();
  }

  function drawWaveform(ctx, p, axis, width, top, waveH) {
    ctx.fillStyle = '#1b232b';
    ctx.fillRect(0, top, width, waveH);
    const mid = top + waveH / 2;
    let drewAny = false;

    for (const asset of p.assets) {
      const entry = axis.map.get(asset.id);
      if (!entry) continue;
      const analysis = assetAnalysis(p, asset.id);
      const db = analysis.envelope.db;
      const hop = analysis.envelope.hopSec || 0.01;
      const left = (entry.offset / axis.total) * width;
      const right = ((entry.offset + entry.duration) / axis.total) * width;

      if (!db.length) {
        // 画像・音声なしの素材はその区間を薄く塗る
        ctx.fillStyle = 'rgba(167,180,194,0.10)';
        ctx.fillRect(left, top, Math.max(1, right - left), waveH);
        continue;
      }
      drewAny = true;
      ctx.fillStyle = COLORS.accent;
      for (let px = Math.floor(left); px < right; px += 1) {
        const localRatio = (px - left) / Math.max(1, right - left);
        const from = Math.floor((localRatio * entry.duration) / hop);
        const to = Math.max(from + 1, Math.floor((((px + 1 - left) / Math.max(1, right - left)) * entry.duration) / hop));
        let peak = -100;
        for (let i = from; i < to && i < db.length; i += 1) peak = Math.max(peak, db[i]);
        if (peak <= -100) continue;
        const amp = clamp((peak + 60) / 60, 0, 1);
        const half = (amp * waveH) / 2;
        ctx.fillRect(px, mid - half, 1, Math.max(1, half * 2));
      }
    }

    if (!drewAny) {
      ctx.fillStyle = COLORS.textMuted;
      ctx.font = '12px system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(p.assets.length ? '音声なし / 未解析' : '', 8, mid + 4);
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
