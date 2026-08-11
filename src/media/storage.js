/**
 * 素材ファイルの永続化（OPFS: Origin Private File System）。
 *
 * スマートフォンのブラウザはメモリ不足でタブを頻繁に破棄する。
 * 動画そのものを保存しておけば、復帰時に「もう一度ファイルを選んでください」と
 * 言わずに済む。localStorage には入らないサイズなので OPFS を使う。
 */

const SOURCE_FILE = 'source.media';
const META_FILE = 'source.json';
/** これを超える素材は保存しない（端末の空き容量を圧迫するため） */
export const MAX_PERSIST_BYTES = 600 * 1024 * 1024;

export function isOpfsAvailable() {
  return (
    typeof navigator !== 'undefined' &&
    navigator.storage &&
    typeof navigator.storage.getDirectory === 'function' &&
    typeof FileSystemWritableFileStream !== 'undefined'
  );
}

async function root() {
  return navigator.storage.getDirectory();
}

/**
 * 素材を保存する。容量超過や非対応でも例外にはせず、理由を返す。
 * @returns {Promise<{ok:boolean, reason?:string}>}
 */
export async function saveSourceFile(file) {
  if (!isOpfsAvailable()) return { ok: false, reason: 'この環境では素材を保存できません。' };
  if (!file) return { ok: false, reason: '保存する素材がありません。' };
  if (file.size > MAX_PERSIST_BYTES) {
    return { ok: false, reason: `素材が大きいため保存を見送りました（${Math.round(MAX_PERSIST_BYTES / 1024 / 1024)}MB まで）。` };
  }
  try {
    const dir = await root();
    const handle = await dir.getFileHandle(SOURCE_FILE, { create: true });
    const writable = await handle.createWritable();
    await file.stream().pipeTo(writable);

    const metaHandle = await dir.getFileHandle(META_FILE, { create: true });
    const metaWritable = await metaHandle.createWritable();
    await metaWritable.write(JSON.stringify({ name: file.name, type: file.type, size: file.size, savedAt: Date.now() }));
    await metaWritable.close();
    return { ok: true };
  } catch (error) {
    if (error?.name === 'QuotaExceededError') {
      return { ok: false, reason: '端末の空き容量が不足しているため素材を保存できませんでした。' };
    }
    return { ok: false, reason: '素材を保存できませんでした。' };
  }
}

/**
 * 保存済み素材を読み出す。
 * @returns {Promise<File|null>}
 */
export async function loadSourceFile() {
  if (!isOpfsAvailable()) return null;
  try {
    const dir = await root();
    const metaHandle = await dir.getFileHandle(META_FILE);
    const meta = JSON.parse(await (await metaHandle.getFile()).text());
    const handle = await dir.getFileHandle(SOURCE_FILE);
    const file = await handle.getFile();
    if (!file.size) return null;
    return new File([file], meta.name || '素材', { type: meta.type || file.type });
  } catch {
    return null; // 未保存、または読み出し不能
  }
}

export async function clearSourceFile() {
  if (!isOpfsAvailable()) return;
  try {
    const dir = await root();
    await dir.removeEntry(SOURCE_FILE).catch(() => {});
    await dir.removeEntry(META_FILE).catch(() => {});
  } catch {
    /* 失敗しても致命的ではない */
  }
}

/**
 * 使用量の目安を返す。
 * @returns {Promise<{usage:number, quota:number}|null>}
 */
export async function estimateStorage() {
  if (typeof navigator === 'undefined' || !navigator.storage?.estimate) return null;
  try {
    const { usage = 0, quota = 0 } = await navigator.storage.estimate();
    return { usage, quota };
  } catch {
    return null;
  }
}
