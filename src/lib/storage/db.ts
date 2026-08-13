import type { AudioAnalysis } from '../audio/types';
import type { CharacterAppearance } from '../character/appearance';
import type { MotionClip } from '../pose/types';
import type { Project } from '../project/types';

const DB_NAME = 'motion-muse';
const DB_VERSION = 2;

export const STORES = {
  projects: 'projects',
  clips: 'clips',
  audio: 'audio',
  characters: 'characters',
  avatars: 'avatars',
  meta: 'meta',
} as const;

export interface AudioAsset {
  id: string;
  name: string;
  fileName: string;
  mimeType: string;
  size: number;
  duration: number;
  blob: Blob;
  analysis: AudioAnalysis;
  createdAt: number;
  /** 任意: トレンド情報を紐づけた場合のメタデータ */
  trend?: TrendMeta;
}

export interface TrendMeta {
  /** ユーザーが取り込んだトレンド一覧上の表示名 */
  title: string;
  artist?: string;
  /** 再生数など、取り込んだ指標 */
  metric?: number;
  region?: string;
  sourceNote: string;
}

/** 読み込んだ 3D アバター（VRM / glTF）の保存形式。 */
export interface AvatarAsset {
  id: string;
  name: string;
  fileName: string;
  size: number;
  kind: 'vrm' | 'gltf';
  /** 対応付けできたヒューマノイドボーン数 */
  boneCount: number;
  blob: Blob;
  createdAt: number;
}

export class StorageError extends Error {
  constructor(message: string, readonly cause?: unknown, readonly hint?: string) {
    super(message);
    this.name = 'StorageError';
  }
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(
        new StorageError(
          'このブラウザではローカル保存（IndexedDB）が利用できません。',
          null,
          'プライベートブラウジングを解除するか、別のブラウザをお試しください。',
        ),
      );
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const store of Object.values(STORES)) {
        if (!db.objectStoreNames.contains(store)) {
          db.createObjectStore(store, { keyPath: store === STORES.meta ? 'key' : 'id' });
        }
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () =>
      reject(
        new StorageError(
          'ローカルデータベースを開けませんでした。',
          request.error,
          'ブラウザのストレージ設定（Cookie/サイトデータのブロック）を確認してください。',
        ),
      );
  });
  return dbPromise;
}

async function withStore<T>(
  storeName: string,
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const request = fn(tx.objectStore(storeName));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      const error = request.error;
      reject(
        new StorageError(
          error?.name === 'QuotaExceededError'
            ? 'ブラウザの保存容量が上限に達しました。'
            : 'データの読み書きに失敗しました。',
          error,
          error?.name === 'QuotaExceededError'
            ? '不要なプロジェクトや音源を削除してから再度お試しください。'
            : undefined,
        ),
      );
    };
  });
}

async function getAll<T>(storeName: string): Promise<T[]> {
  return withStore<T[]>(storeName, 'readonly', (store) => store.getAll() as IDBRequest<T[]>);
}

export const db = {
  // --- プロジェクト -------------------------------------------------------
  listProjects: () => getAll<Project>(STORES.projects),
  getProject: (id: string) =>
    withStore<Project | undefined>(STORES.projects, 'readonly', (s) => s.get(id) as IDBRequest<Project | undefined>),
  saveProject: (project: Project) =>
    withStore(STORES.projects, 'readwrite', (s) => s.put({ ...project, updatedAt: Date.now() })),
  deleteProject: (id: string) => withStore(STORES.projects, 'readwrite', (s) => s.delete(id)),

  // --- モーションクリップ -------------------------------------------------
  listClips: () => getAll<MotionClip>(STORES.clips),
  getClip: (id: string) =>
    withStore<MotionClip | undefined>(STORES.clips, 'readonly', (s) => s.get(id) as IDBRequest<MotionClip | undefined>),
  saveClip: (clip: MotionClip) => withStore(STORES.clips, 'readwrite', (s) => s.put(clip)),
  deleteClip: (id: string) => withStore(STORES.clips, 'readwrite', (s) => s.delete(id)),

  // --- 音源 ---------------------------------------------------------------
  listAudio: () => getAll<AudioAsset>(STORES.audio),
  getAudio: (id: string) =>
    withStore<AudioAsset | undefined>(STORES.audio, 'readonly', (s) => s.get(id) as IDBRequest<AudioAsset | undefined>),
  saveAudio: (asset: AudioAsset) => withStore(STORES.audio, 'readwrite', (s) => s.put(asset)),
  deleteAudio: (id: string) => withStore(STORES.audio, 'readwrite', (s) => s.delete(id)),

  // --- キャラクタープリセット ---------------------------------------------
  listCharacters: () => getAll<CharacterAppearance>(STORES.characters),
  saveCharacter: (character: CharacterAppearance) =>
    withStore(STORES.characters, 'readwrite', (s) => s.put(character)),
  deleteCharacter: (id: string) => withStore(STORES.characters, 'readwrite', (s) => s.delete(id)),

  // --- アバター -----------------------------------------------------------
  listAvatars: () => getAll<AvatarAsset>(STORES.avatars),
  getAvatar: (id: string) =>
    withStore<AvatarAsset | undefined>(STORES.avatars, 'readonly', (s) => s.get(id) as IDBRequest<AvatarAsset | undefined>),
  saveAvatar: (asset: AvatarAsset) => withStore(STORES.avatars, 'readwrite', (s) => s.put(asset)),
  deleteAvatar: (id: string) => withStore(STORES.avatars, 'readwrite', (s) => s.delete(id)),

  // --- メタ情報 -----------------------------------------------------------
  getMeta: <T>(key: string) =>
    withStore<{ key: string; value: T } | undefined>(STORES.meta, 'readonly', (s) => s.get(key) as IDBRequest<{ key: string; value: T } | undefined>),
  setMeta: <T>(key: string, value: T) =>
    withStore(STORES.meta, 'readwrite', (s) => s.put({ key, value })),
};

/** 保存容量の使用状況（UIで警告を出すため）。 */
export async function estimateStorage(): Promise<{ usage: number; quota: number } | null> {
  if (typeof navigator === 'undefined' || !navigator.storage?.estimate) return null;
  try {
    const { usage = 0, quota = 0 } = await navigator.storage.estimate();
    return { usage, quota };
  } catch {
    return null;
  }
}
