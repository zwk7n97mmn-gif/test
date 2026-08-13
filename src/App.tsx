import { useEffect, useRef, useState } from 'react';
import { PreviewStage } from './components/PreviewStage';
import { InstallBanner } from './components/InstallBanner';
import { AudioPanel } from './panels/AudioPanel';
import { CharacterPanel } from './panels/CharacterPanel';
import { ExportPanel } from './panels/ExportPanel';
import { MotionPanel } from './panels/MotionPanel';
import { StagePanel } from './panels/StagePanel';
import { useCurrentAssets, useWorkspace } from './state/workspace';
import { Alert, EmptyState, useToast } from './ui/primitives';

const TABS = [
  { id: 'audio', label: '音源', icon: '🎵', render: () => <AudioPanel /> },
  { id: 'motion', label: 'モーション', icon: '🕺', render: () => <MotionPanel /> },
  { id: 'character', label: '容姿', icon: '🧍', render: () => <CharacterPanel /> },
  { id: 'stage', label: '演出', icon: '✨', render: () => <StagePanel /> },
  { id: 'export', label: '書き出し', icon: '⬇️', render: () => <ExportPanel /> },
] as const;

type TabId = (typeof TABS)[number]['id'];

export function App() {
  const { status, loadError, projects, project, selectProject, addProject, removeProject } = useWorkspace();
  const { clip, audio } = useCurrentAssets();
  const toast = useToast();
  const [tab, setTab] = useState<TabId>('audio');
  const tabRefs = useRef(new Map<TabId, HTMLButtonElement>());
  const contentRef = useRef<HTMLDivElement>(null);

  // タブを切り替えたら本文を先頭に戻す（スマートフォンでは位置が残ると迷子になる）
  useEffect(() => {
    contentRef.current?.scrollTo({ top: 0 });
  }, [tab]);

  // 左右矢印 / Home / End でタブを移動できるようにする（WAI-ARIA Tabs パターン）
  const onTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    const keys: Record<string, number> = {
      ArrowRight: (index + 1) % TABS.length,
      ArrowLeft: (index - 1 + TABS.length) % TABS.length,
      Home: 0,
      End: TABS.length - 1,
    };
    const nextIndex = keys[event.key];
    if (nextIndex === undefined) return;
    event.preventDefault();
    const nextTab = TABS[nextIndex].id;
    setTab(nextTab);
    tabRefs.current.get(nextTab)?.focus();
  };

  if (status === 'loading') {
    return (
      <div className="app" role="status" aria-live="polite">
        <div style={{ display: 'grid', placeItems: 'center', height: '100dvh', gap: 12 }}>
          <span className="spinner" aria-hidden="true" />
          <p>読み込んでいます…</p>
        </div>
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className="app">
        <div style={{ padding: 20 }}>
          <Alert kind="error" title="起動できませんでした">
            {loadError ?? '不明なエラーです。'}
          </Alert>
          <button type="button" className="btn btn-primary btn-block" onClick={() => window.location.reload()}>
            再読み込み
          </button>
        </div>
      </div>
    );
  }

  /** 未完了のステップに印を出して、次に何をすればよいか分かるようにする */
  const todo: Record<TabId, boolean> = {
    audio: !audio,
    motion: !clip,
    character: false,
    stage: false,
    export: Boolean(clip),
  };

  return (
    <div className="app">
      <a className="skip-link" href="#main-content">
        メインコンテンツへスキップ
      </a>

      <header className="app-header">
        <h1>Motion Muse</h1>
        <label htmlFor="project-select" className="visually-hidden">
          プロジェクトを選択
        </label>
        <select id="project-select" value={project?.id ?? ''} onChange={(event) => selectProject(event.target.value)}>
          {projects.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="btn btn-small"
          aria-label="新しいプロジェクトを作成"
          onClick={() => void addProject().catch((err) => toast.pushError(err))}
        >
          ＋
        </button>
        <button
          type="button"
          className="btn btn-small btn-danger"
          aria-label="このプロジェクトを削除"
          disabled={projects.length <= 1 || !project}
          onClick={() => {
            if (!project) return;
            if (window.confirm(`プロジェクト「${project.name}」を削除します。よろしいですか？`)) {
              void removeProject(project.id).catch((err) => toast.pushError(err));
            }
          }}
        >
          🗑
        </button>
      </header>

      {project ? <PreviewStage /> : <div />}

      <main id="main-content" className="content" ref={contentRef}>
        {!project ? (
          <EmptyState title="プロジェクトがありません">
            上部の「＋」から作成してください。
          </EmptyState>
        ) : (
          <>
            <InstallBanner />
            {TABS.map((item) => (
              <div
                key={item.id}
                role="tabpanel"
                id={`panel-${item.id}`}
                aria-labelledby={`tab-${item.id}`}
                hidden={tab !== item.id}
              >
                {tab === item.id && item.render()}
              </div>
            ))}
          </>
        )}
      </main>

      <nav className="bottom-nav" role="tablist" aria-label="編集ステップ">
        {TABS.map((item, index) => (
          <button
            key={item.id}
            ref={(element) => {
              if (element) tabRefs.current.set(item.id, element);
              else tabRefs.current.delete(item.id);
            }}
            type="button"
            role="tab"
            id={`tab-${item.id}`}
            className="nav-item"
            aria-selected={tab === item.id}
            aria-controls={`panel-${item.id}`}
            tabIndex={tab === item.id ? 0 : -1}
            onClick={() => setTab(item.id)}
            onKeyDown={(event) => onTabKeyDown(event, index)}
          >
            <span className="nav-icon" aria-hidden="true">
              {item.icon}
            </span>
            <span>{item.label}</span>
            {todo[item.id] && tab !== item.id && <span className="nav-badge" aria-hidden="true" />}
          </button>
        ))}
      </nav>
    </div>
  );
}
