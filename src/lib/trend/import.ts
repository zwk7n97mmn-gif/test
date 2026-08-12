import type { TrendMeta } from '../storage/db';

export interface TrendEntry extends TrendMeta {
  id: string;
  rank: number;
}

export class TrendImportError extends Error {
  constructor(message: string, readonly hint?: string) {
    super(message);
    this.name = 'TrendImportError';
  }
}

/**
 * 手元のトレンド一覧（CSV / JSON）を取り込む。
 *
 * 本ツールは TikTok から自動でデータを取得しない。TikTok Creative Center などの
 * 公式画面からユーザー自身がエクスポートした一覧を読み込む方式にしている
 * （利用規約に反するスクレイピングを行わないため）。
 *
 * 対応列（大文字小文字・全角半角を問わない）:
 *   タイトル / title / song / 楽曲名   … 必須
 *   アーティスト / artist / 歌手
 *   再生数 / plays / views / count / 指標
 *   地域 / region / country
 */
export function parseTrendList(text: string, sourceNote: string): TrendEntry[] {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new TrendImportError('ファイルが空です。', 'タイトル列を含む CSV または JSON を読み込んでください。');
  }

  const rows = trimmed.startsWith('[') || trimmed.startsWith('{') ? parseJsonRows(trimmed) : parseCsvRows(trimmed);
  if (rows.length === 0) {
    throw new TrendImportError('取り込めるデータ行がありませんでした。');
  }

  const entries: TrendEntry[] = [];
  rows.forEach((row, index) => {
    const title = pick(row, ['タイトル', 'title', 'song', 'songname', 'song_name', '楽曲名', 'music', 'name']);
    if (!title) return;
    const metricRaw = pick(row, ['再生数', 'plays', 'views', 'count', '指標', 'posts', 'videos', 'value']);
    const metric = metricRaw ? parseMetric(metricRaw) : undefined;
    entries.push({
      id: `${index}-${title}`.slice(0, 120),
      rank: entries.length + 1,
      title: title.slice(0, 200),
      artist: pick(row, ['アーティスト', 'artist', '歌手', 'author', 'creator'])?.slice(0, 120),
      metric: Number.isFinite(metric) ? metric : undefined,
      region: pick(row, ['地域', 'region', 'country', 'market'])?.slice(0, 60),
      sourceNote,
    });
  });

  if (entries.length === 0) {
    throw new TrendImportError(
      'タイトル列を認識できませんでした。',
      'ヘッダー行に「タイトル」「title」「楽曲名」などの列名が含まれているか確認してください。',
    );
  }
  return entries;
}

function parseJsonRows(text: string): Array<Record<string, string>> {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new TrendImportError('JSON の解析に失敗しました。', err instanceof Error ? err.message : undefined);
  }
  const array = Array.isArray(data)
    ? data
    : typeof data === 'object' && data !== null && Array.isArray((data as { items?: unknown[] }).items)
      ? (data as { items: unknown[] }).items
      : null;
  if (!array) {
    throw new TrendImportError(
      'JSON の形式が想定と異なります。',
      '配列、または items 配列を持つオブジェクトを指定してください。',
    );
  }
  return array
    .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
    .map((item) => {
      const row: Record<string, string> = {};
      for (const [key, value] of Object.entries(item)) {
        if (value === null || value === undefined) continue;
        if (typeof value === 'object') continue;
        row[normalizeKey(key)] = String(value);
      }
      return row;
    });
}

function parseCsvRows(text: string): Array<Record<string, string>> {
  const table = parseCsv(text);
  if (table.length < 2) return [];
  const header = table[0].map(normalizeKey);
  return table.slice(1).map((cells) => {
    const row: Record<string, string> = {};
    header.forEach((key, i) => {
      row[key] = (cells[i] ?? '').trim();
    });
    return row;
  });
}

/** RFC4180 相当（引用符・改行入りセル・BOM に対応）の CSV パーサ。 */
export function parseCsv(text: string): string[][] {
  const source = text.replace(/^﻿/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (inQuotes) {
      if (char === '"') {
        if (source[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
    } else if (char === ',' || char === '\t') {
      row.push(cell);
      cell = '';
    } else if (char === '\r') {
      // 次の \n で処理する
    } else if (char === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

function normalizeKey(key: string): string {
  return key
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '')
    // 全角英数字を半角へ
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
}

function pick(row: Record<string, string>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = row[normalizeKey(key)];
    if (value !== undefined && value.trim() !== '') return value.trim();
  }
  return undefined;
}

/** "1.2M" "34,567" "8.9万" などを数値へ。 */
export function parseMetric(text: string): number {
  const cleaned = text.replace(/[,\s]/g, '');
  const match = cleaned.match(/^([0-9]*\.?[0-9]+)\s*([KkMmBb万億]?)/);
  if (!match) return NaN;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return NaN;
  switch (match[2]) {
    case 'K':
    case 'k':
      return value * 1e3;
    case 'M':
    case 'm':
      return value * 1e6;
    case 'B':
    case 'b':
      return value * 1e9;
    case '万':
      return value * 1e4;
    case '億':
      return value * 1e8;
    default:
      return value;
  }
}

export function formatMetric(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '—';
  if (value >= 1e8) return `${(value / 1e8).toFixed(1)}億`;
  if (value >= 1e4) return `${(value / 1e4).toFixed(1)}万`;
  return value.toLocaleString('ja-JP');
}
