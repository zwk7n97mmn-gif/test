/**
 * Web Share API による共有。
 *
 * スマートフォンで「完結」するには、書き出したファイルを SNS アプリへ直接渡せることが要る。
 * ダウンロードでは iOS の「ファイル」アプリに落ちるだけで、そこから先が手作業になる。
 * 対応していない環境では従来どおりダウンロードへ退避する。
 */

import { downloadBlob } from './exporter.js';

/** ファイル共有が使えるか（実際に共有できるかは files を渡して判定する必要がある） */
export function canShareFiles(files) {
  if (typeof navigator === 'undefined' || typeof navigator.canShare !== 'function' || typeof navigator.share !== 'function') {
    return false;
  }
  try {
    return navigator.canShare({ files });
  } catch {
    return false;
  }
}

export function canShareText() {
  return typeof navigator !== 'undefined' && typeof navigator.share === 'function';
}

/**
 * ファイルを共有する。共有できない場合はダウンロードへ退避する。
 * @param {{blob:Blob, filename:string, title?:string, text?:string}} opt
 * @returns {Promise<{method:'share'|'download'|'cancelled', error?:Error}>}
 */
export async function shareFile({ blob, filename, title, text }) {
  const file = new File([blob], filename, { type: blob.type || 'application/octet-stream' });
  if (canShareFiles([file])) {
    try {
      await navigator.share({ files: [file], title, text });
      return { method: 'share' };
    } catch (error) {
      // ユーザーが共有シートを閉じた場合は失敗として扱わない
      if (error?.name === 'AbortError') return { method: 'cancelled' };
      downloadBlob(blob, filename);
      return { method: 'download', error };
    }
  }
  downloadBlob(blob, filename);
  return { method: 'download' };
}

/**
 * テキストを共有する。
 * @returns {Promise<{method:'share'|'cancelled'|'unsupported'}>}
 */
export async function shareText({ title, text, url }) {
  if (!canShareText()) return { method: 'unsupported' };
  try {
    await navigator.share({ title, text, url });
    return { method: 'share' };
  } catch (error) {
    if (error?.name === 'AbortError') return { method: 'cancelled' };
    return { method: 'unsupported' };
  }
}
