/**
 * 素材ファイルの永続化（OPFS: Origin Private File System）。
 *
 * スマートフォンのブラウザはメモリ不足でタブを頻繁に破棄する。
 * 素材そのものを保存しておけば、復帰時に「もう一度ファイルを選んでください」と
 * 言わずに済む。localStorage には入らないサイズなので OPFS を使う。
 *
 * 複数素材に対応するため、素材 ID ごとにファイルを分けて保存する。
 */

const DIR_NAME = 'assets';
const META_SUFFIX = '.json';
const DATA_SUFFIX = '.bin';
/** 1 素材あたりの上限（端末の空き容量を圧迫しないため） */
export const MAX_PERSIST_BYTES = 600 * 1024 * 1024;
/** 保存する合計サイズの上限 */
export const MAX_TOTAL_PERSIST_BYTES = 1500 * 1024 * 1024;

export function isOpfsAvailable() {
  return (
    typeof navigator !== 'undefined' &&
    navigator.storage &&
    typeof navigator.storage.getDirectory === 'function' &&
    typeof FileSystemWritableFileStream !== 'undefined'
  );
}

async function dir() {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(DIR_NAME, { create: true });
}

/** ファイル名に使えない文字を落とす */
function safeId(assetId) {
  return String(assetId || '').replace(/[^A-Za-z0-9_-]/g, '') || 'asset';
}

/**
 * 素材を保存する。容量超過や非対応でも例外にはせず、理由を返す。
 * @param {File} file
 * @param {string} assetId
 * @returns {Promise<{ok:boolean, reason?:string}>}
 */
export async function saveSourceFile(file, assetId) {
  if (!isOpfsAvailable()) return { ok: false, reason: 'この環境では素材を保存できません。' };
  if (!file || !assetId) return { ok: false, reason: '保存する素材がありません。' };
  if (file.size > MAX_PERSIST_BYTES) {
    return { ok: false, reason: `${file.name} は大きいため保存を見送りました（${Math.round(MAX_PERSIST_BYTES / 1024 / 1024)}MB まで）。` };
  }
  try {
    const folder = await dir();
    const id = safeId(assetId);
    const handle = await folder.getFileHandle(`${id}${DATA_SUFFIX}`, { create: true });
    const writable = await handle.createWritable();
    await file.stream().pipeTo(writable);

    const metaHandle = await folder.getFileHandle(`${id}${META_SUFFIX}`, { create: true });
    const metaWritable = await metaHandle.createWritable();
    await metaWritable.write(JSON.stringify({
      assetId,
      name: file.name,
      type: file.type,
      size: file.size,
      savedAt: Date.now(),
    }));
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
 * @param {string} assetId
 * @returns {Promise<File|null>}
 */
export async function loadSourceFile(assetId) {
  if (!isOpfsAvailable() || !assetId) return null;
  try {
    const folder = await dir();
    const id = safeId(assetId);
    const metaHandle = await folder.getFileHandle(`${id}${META_SUFFIX}`);
    const meta = JSON.parse(await (await metaHandle.getFile()).text());
    const handle = await folder.getFileHandle(`${id}${DATA_SUFFIX}`);
    const file = await handle.getFile();
    if (!file.size) return null;
    return new File([file], meta.name || '素材', { type: meta.type || file.type });
  } catch {
    return null; // 未保存、または読み出し不能
  }
}

/** 指定素材（省略時はすべて）の保存を消す */
export async function clearSourceFile(assetId) {
  if (!isOpfsAvailable()) return;
  try {
    const folder = await dir();
    if (assetId) {
      const id = safeId(assetId);
      await folder.removeEntry(`${id}${DATA_SUFFIX}`).catch(() => {});
      await folder.removeEntry(`${id}${META_SUFFIX}`).catch(() => {});
      return;
    }
    for await (const name of folder.keys()) {
      await folder.removeEntry(name).catch(() => {});
    }
  } catch {
    /* 失敗しても致命的ではない */
  }
}

/**
 * 保存済みだがプロジェクトに存在しない素材を掃除する。
 * @param {string[]} validAssetIds
 */
export async function pruneSavedAssets(validAssetIds) {
  if (!isOpfsAvailable()) return;
  const keep = new Set((validAssetIds || []).map(safeId));
  try {
    const folder = await dir();
    const names = [];
    for await (const name of folder.keys()) names.push(name);
    for (const name of names) {
      const id = name.replace(/\.(bin|json)$/, '');
      if (!keep.has(id)) await folder.removeEntry(name).catch(() => {});
    }
  } catch {
    /* 掃除できなくても動作に影響はない */
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
