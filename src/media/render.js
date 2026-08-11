/**
 * フレーム描画（プレビューと書き出しで共有）。
 * ここを唯一の描画実装にすることで「プレビューと成果物の見た目が違う」事故を防ぐ。
 */

import { wrapText } from '../core/subtitles.js';
import { clamp } from '../core/util.js';
import { THUMBNAIL_TEMPLATES, layoutThumbnailText } from '../core/thumbnail.js';

/**
 * 映像を letterbox 配置で描画する。
 */
export function drawVideoFrame(ctx, source, width, height, { background = '#000000' } = {}) {
  ctx.save();
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, width, height);
  const sw = source?.videoWidth || source?.width || 0;
  const sh = source?.videoHeight || source?.height || 0;
  if (sw > 0 && sh > 0) {
    const scale = Math.min(width / sw, height / sh);
    const dw = sw * scale;
    const dh = sh * scale;
    try {
      ctx.drawImage(source, (width - dw) / 2, (height - dh) / 2, dw, dh);
    } catch {
      // まだデコード済みフレームが無い場合は黒のまま
    }
  }
  ctx.restore();
}

/**
 * 字幕を焼き込む。
 * @param {CanvasRenderingContext2D} ctx
 * @param {{text:string}} cue
 * @param {object} style project.subtitleStyle
 */
export function drawSubtitle(ctx, cue, style, width, height) {
  const text = String(cue?.text ?? '').trim();
  if (!text) return;
  const fontSize = Math.max(12, Math.round(height * clamp(style.fontSize, 0.02, 0.2)));
  const margin = Math.round(height * clamp(style.safeMargin, 0, 0.2));
  const maxWidth = width - margin * 2;
  const perLine = Math.max(4, Math.min(style.maxCharsPerLine, Math.floor(maxWidth / (fontSize * 0.92))));
  const lines = wrapText(text, perLine, style.maxLines);
  if (!lines.length) return;

  ctx.save();
  ctx.font = `${style.weight} ${fontSize}px ${style.family}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const lineHeight = Math.round(fontSize * 1.35);
  const blockHeight = lines.length * lineHeight;

  let topY;
  if (style.position === 'top') topY = margin;
  else if (style.position === 'center') topY = (height - blockHeight) / 2;
  else topY = height - margin - blockHeight;

  if (style.background && style.background !== 'none') {
    const widest = Math.max(...lines.map((l) => ctx.measureText(l).width));
    const padX = fontSize * 0.5;
    const padY = fontSize * 0.28;
    ctx.fillStyle = style.background;
    const bw = Math.min(width - margin, widest + padX * 2);
    roundRect(ctx, (width - bw) / 2, topY - padY, bw, blockHeight + padY * 2, fontSize * 0.25);
    ctx.fill();
  }

  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;
  ctx.lineWidth = Math.max(1, fontSize * clamp(style.strokeWidth, 0, 0.5));
  ctx.strokeStyle = style.strokeColor;
  ctx.fillStyle = style.color;
  lines.forEach((line, i) => {
    const y = topY + lineHeight * i + lineHeight / 2;
    if (ctx.lineWidth > 0) ctx.strokeText(line, width / 2, y, maxWidth);
    ctx.fillText(line, width / 2, y, maxWidth);
  });
  ctx.restore();
}

function roundRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

/**
 * サムネイルを描画する（プレビュー用 canvas と書き出し用 canvas の双方で使用）。
 * @param {CanvasRenderingContext2D} ctx
 * @param {CanvasImageSource} source
 * @param {object} thumbnail project.thumbnail
 */
export function drawThumbnail(ctx, source, thumbnail, width, height) {
  drawVideoFrame(ctx, source, width, height);
  const template = THUMBNAIL_TEMPLATES[thumbnail.template] || THUMBNAIL_TEMPLATES.boldBottom;
  const layout = layoutThumbnailText({
    title: thumbnail.title,
    subtitle: thumbnail.subtitle,
    template: thumbnail.template,
    width,
    height,
  });

  if (thumbnail.scrim !== false) {
    ctx.save();
    if (template.align === 'left') {
      const grad = ctx.createLinearGradient(0, 0, width * 0.75, 0);
      grad.addColorStop(0, `rgba(0,0,0,${template.scrim})`);
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = grad;
    } else if (template.align === 'center') {
      ctx.fillStyle = `rgba(0,0,0,${template.scrim * 0.7})`;
    } else {
      const grad = ctx.createLinearGradient(0, height, 0, height * 0.35);
      grad.addColorStop(0, `rgba(0,0,0,${template.scrim})`);
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = grad;
    }
    ctx.fillRect(0, 0, width, height);
    ctx.restore();
  }

  const centered = layout.align === 'center' || layout.align === 'bottom';
  const textX = centered ? width / 2 : layout.margin;
  ctx.save();
  ctx.textAlign = centered ? 'center' : 'left';
  ctx.textBaseline = 'top';
  ctx.lineJoin = 'round';

  let y = layout.box.y;
  ctx.font = `900 ${layout.titleSize}px ${'system-ui, "Hiragino Sans", "Noto Sans JP", sans-serif'}`;
  for (const line of layout.titleLines) {
    ctx.lineWidth = layout.strokeWidth;
    ctx.strokeStyle = 'rgba(0,0,0,0.9)';
    ctx.strokeText(line, textX, y);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(line, textX, y);
    y += layout.lineHeight;
  }
  if (layout.subtitleLines.length) {
    y += layout.titleSize * 0.35;
    ctx.font = `700 ${layout.subtitleSize}px ${'system-ui, "Hiragino Sans", "Noto Sans JP", sans-serif'}`;
    for (const line of layout.subtitleLines) {
      ctx.lineWidth = Math.max(2, layout.strokeWidth * 0.6);
      ctx.strokeStyle = 'rgba(0,0,0,0.9)';
      ctx.strokeText(line, textX, y);
      ctx.fillStyle = thumbnail.accent || '#4da3ff';
      ctx.fillText(line, textX, y);
      y += layout.subLineHeight;
    }
  }
  ctx.restore();

  const badge = String(thumbnail.badge ?? '').trim();
  if (badge) {
    ctx.save();
    const size = Math.round(height * 0.045);
    ctx.font = `800 ${size}px system-ui, sans-serif`;
    const padding = size * 0.5;
    const w = ctx.measureText(badge).width + padding * 2;
    const h = size * 1.9;
    const x = width - layout.margin - w;
    const yPos = layout.margin;
    ctx.fillStyle = thumbnail.accent || '#4da3ff';
    roundRect(ctx, x, yPos, w, h, h * 0.28);
    ctx.fill();
    ctx.fillStyle = '#08111b';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(badge, x + w / 2, yPos + h / 2);
    ctx.restore();
  }
}
