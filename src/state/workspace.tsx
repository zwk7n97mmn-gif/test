import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createSampleAppearances, type CharacterAppearance } from '../lib/character/appearance';
import type { MotionClip } from '../lib/pose/types';
import { createProject, sanitizeProject, type Project } from '../lib/project/types';
import { db, estimateStorage, type AudioAsset } from '../lib/storage/db';
import type { TrendEntry } from '../lib/trend/import';

export type LoadStatus = 'loading' | 'ready' | 'error';

interface WorkspaceValue {
  status: LoadStatus;
  loadError: string | null;
  projects: Project[];
  project: Project | null;
  clips: MotionClip[];
  audioAssets: AudioAsset[];
  characters: CharacterAppearance[];
  trends: TrendEntry[];
  storage: { usage: number; quota: number } | null;

  selectProject: (id: string) => void;
  addProject: () => Promise<Project>;
  updateProject: (patch: Partial<Project> | ((current: Project) => Partial<Project>)) => void;
  removeProject: (id: string) => Promise<void>;

  addClip: (clip: MotionClip) => Promise<void>;
  removeClip: (id: string) => Promise<void>;

  addAudio: (asset: AudioAsset) => Promise<void>;
  updateAudio: (asset: AudioAsset) => Promise<void>;
  removeAudio: (id: string) => Promise<void>;
  /** デコード済み AudioBuffer のキャッシュ（再生・書き出し用、永続化しない） */
  getAudioBuffer: (id: string) => AudioBuffer | null;
  setAudioBuffer: (id: string, buffer: AudioBuffer) => void;

  saveCharacterPreset: (appearance: CharacterAppearance) => Promise<void>;
  removeCharacterPreset: (id: string) => Promise<void>;

  setTrends: (entries: TrendEntry[]) => void;
  refreshStorage: () => void;
}

const WorkspaceContext = createContext<WorkspaceValue | null>(null);

const LAST_PROJECT_KEY = 'last-project-id';

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<LoadStatus>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [clips, setClips] = useState<MotionClip[]>([]);
  const [audioAssets, setAudioAssets] = useState<AudioAsset[]>([]);
  const [characters, setCharacters] = useState<CharacterAppearance[]>([]);
  const [trends, setTrendState] = useState<TrendEntry[]>([]);
  const [storage, setStorage] = useState<{ usage: number; quota: number } | null>(null);

  const audioBuffers = useRef(new Map<string, AudioBuffer>());
  const saveTimer = useRef<number | null>(null);

  const refreshStorage = useCallback(() => {
    void estimateStorage().then(setStorage);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [loadedProjects, loadedClips, loadedAudio, loadedCharacters, lastId] = await Promise.all([
          db.listProjects(),
          db.listClips(),
          db.listAudio(),
          db.listCharacters(),
          db.getMeta<string>(LAST_PROJECT_KEY),
        ]);
        if (cancelled) return;

        let nextProjects = loadedProjects.map(sanitizeProject);
        let nextCharacters = loadedCharacters;

        // 初回起動時のみサンプルを用意する（機能そのものはサンプルに依存しない）
        if (nextCharacters.length === 0) {
          nextCharacters = createSampleAppearances();
          await Promise.all(nextCharacters.map((c) => db.saveCharacter(c)));
        }
        if (nextProjects.length === 0) {
          const first = createProject({
            name: 'はじめてのプロジェクト',
            appearance: { ...nextCharacters[0], id: crypto.randomUUID() },
          });
          await db.saveProject(first);
          nextProjects = [first];
        }

        nextProjects.sort((a, b) => b.updatedAt - a.updatedAt);
        setProjects(nextProjects);
        setClips(loadedClips);
        setAudioAssets(loadedAudio);
        setCharacters(nextCharacters);
        const preferred = nextProjects.find((p) => p.id === lastId?.value) ?? nextProjects[0];
        setCurrentId(preferred?.id ?? null);
        setStatus('ready');
        refreshStorage();
      } catch (err) {
        if (cancelled) return;
        console.error(err);
        setLoadError(
          err instanceof Error ? err.message : 'データの読み込み中に不明なエラーが発生しました。',
        );
        setStatus('error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshStorage]);

  const project = useMemo(
    () => projects.find((p) => p.id === currentId) ?? null,
    [projects, currentId],
  );

  const selectProject = useCallback((id: string) => {
    setCurrentId(id);
    void db.setMeta(LAST_PROJECT_KEY, id);
  }, []);

  /** 入力のたびに IndexedDB へ書くと重いので 400ms デバウンスして保存する。 */
  const scheduleSave = useCallback((next: Project) => {
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      saveTimer.current = null;
      void db.saveProject(next).catch((err) => console.error('プロジェクトの保存に失敗しました', err));
    }, 400);
  }, []);

  const updateProject = useCallback<WorkspaceValue['updateProject']>(
    (patch) => {
      setProjects((prev) => {
        const index = prev.findIndex((p) => p.id === currentId);
        if (index < 0) return prev;
        const current = prev[index];
        const resolved = typeof patch === 'function' ? patch(current) : patch;
        const next: Project = { ...current, ...resolved, updatedAt: Date.now() };
        const copy = prev.slice();
        copy[index] = next;
        scheduleSave(next);
        return copy;
      });
    },
    [currentId, scheduleSave],
  );

  const addProject = useCallback(async () => {
    const next = createProject({ name: `プロジェクト ${projects.length + 1}` });
    await db.saveProject(next);
    setProjects((prev) => [next, ...prev]);
    setCurrentId(next.id);
    void db.setMeta(LAST_PROJECT_KEY, next.id);
    return next;
  }, [projects.length]);

  const removeProject = useCallback(
    async (id: string) => {
      await db.deleteProject(id);
      setProjects((prev) => {
        const next = prev.filter((p) => p.id !== id);
        if (id === currentId) setCurrentId(next[0]?.id ?? null);
        return next;
      });
      refreshStorage();
    },
    [currentId, refreshStorage],
  );

  const addClip = useCallback(
    async (clip: MotionClip) => {
      await db.saveClip(clip);
      setClips((prev) => [clip, ...prev.filter((c) => c.id !== clip.id)]);
      refreshStorage();
    },
    [refreshStorage],
  );

  const removeClip = useCallback(
    async (id: string) => {
      await db.deleteClip(id);
      setClips((prev) => prev.filter((c) => c.id !== id));
      // 参照していたプロジェクトの参照を外す（壊れた参照を残さない）
      setProjects((prev) =>
        prev.map((p) => {
          if (p.motionClipId !== id) return p;
          const next = { ...p, motionClipId: null, updatedAt: Date.now() };
          void db.saveProject(next);
          return next;
        }),
      );
      refreshStorage();
    },
    [refreshStorage],
  );

  const addAudio = useCallback(
    async (asset: AudioAsset) => {
      await db.saveAudio(asset);
      setAudioAssets((prev) => [asset, ...prev.filter((a) => a.id !== asset.id)]);
      refreshStorage();
    },
    [refreshStorage],
  );

  const updateAudio = useCallback(async (asset: AudioAsset) => {
    await db.saveAudio(asset);
    setAudioAssets((prev) => prev.map((a) => (a.id === asset.id ? asset : a)));
  }, []);

  const removeAudio = useCallback(
    async (id: string) => {
      await db.deleteAudio(id);
      audioBuffers.current.delete(id);
      setAudioAssets((prev) => prev.filter((a) => a.id !== id));
      setProjects((prev) =>
        prev.map((p) => {
          if (p.audioAssetId !== id) return p;
          const next = { ...p, audioAssetId: null, range: null, updatedAt: Date.now() };
          void db.saveProject(next);
          return next;
        }),
      );
      refreshStorage();
    },
    [refreshStorage],
  );

  const saveCharacterPreset = useCallback(async (appearance: CharacterAppearance) => {
    await db.saveCharacter(appearance);
    setCharacters((prev) => [appearance, ...prev.filter((c) => c.id !== appearance.id)]);
  }, []);

  const removeCharacterPreset = useCallback(async (id: string) => {
    await db.deleteCharacter(id);
    setCharacters((prev) => prev.filter((c) => c.id !== id));
  }, []);

  const value: WorkspaceValue = {
    status,
    loadError,
    projects,
    project,
    clips,
    audioAssets,
    characters,
    trends,
    storage,
    selectProject,
    addProject,
    updateProject,
    removeProject,
    addClip,
    removeClip,
    addAudio,
    updateAudio,
    removeAudio,
    getAudioBuffer: (id) => audioBuffers.current.get(id) ?? null,
    setAudioBuffer: (id, buffer) => {
      audioBuffers.current.set(id, buffer);
    },
    saveCharacterPreset,
    removeCharacterPreset,
    setTrends: setTrendState,
    refreshStorage,
  };

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceValue {
  const context = useContext(WorkspaceContext);
  if (!context) throw new Error('useWorkspace must be used within WorkspaceProvider');
  return context;
}

/** 現在のプロジェクトが参照しているクリップ・音源を解決する。 */
export function useCurrentAssets() {
  const { project, clips, audioAssets } = useWorkspace();
  const clip = useMemo(
    () => clips.find((c) => c.id === project?.motionClipId) ?? null,
    [clips, project?.motionClipId],
  );
  const audio = useMemo(
    () => audioAssets.find((a) => a.id === project?.audioAssetId) ?? null,
    [audioAssets, project?.audioAssetId],
  );
  return { clip, audio, analysis: audio?.analysis ?? null };
}
