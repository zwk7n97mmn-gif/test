import { useRef, useState } from 'react';
import { PreviewStage } from './components/PreviewStage';
import { AudioPanel } from './panels/AudioPanel';
import { CharacterPanel } from './panels/CharacterPanel';
import { ExportPanel } from './panels/ExportPanel';
import { MotionPanel } from './panels/MotionPanel';
import { StagePanel } from './panels/StagePanel';
import { useWorkspace } from './state/workspace';
import { Alert, EmptyState, useToast } from './ui/primitives';

const TABS = [
  { id: 'audio', label: '音源', render: () => <AudioPanel /> },
  { id: 'motion', label: 'モーション', render: () => <MotionPanel /> },
  { id: 'character', label: '容姿', render: () => <CharacterPanel /> },
  { id: 'stage', label: '演出', render: () => <StagePanel /> },
  { id: 'export', label: '書き出し', render: () => <ExportPanel /> },
] as const;

type TabId = (typeof TABS)[number]['id'];

export function App() {
  const { status, loadError, projects, project, selectProject, addProject, removeProject, updateProject } =
    useWorkspace();
  const toast = useToast();
  const [tab, setTab] = useState<TabId>('audio');
  const tabRefs = useRef(new Map<TabId, HTMLButtonElement>());

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
        <div style={{ display: 'grid', placeItems: 'center', height: '100vh', gap: 12 }}>
          <span className="spinner" aria-hidden="true" />
          <p>保存データを読み込んでいます…</p>
        </div>
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className="app">
        <div style={{ padding: 24, maxWidth: 640 }}>
          <Alert kind="error" title="起動できませんでした">
            {loadError ?? '不明なエラーです。'}
          </Alert>
          <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
            再読み込み
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <a className="skip-link" href="#main-content">
        メインコンテンツへスキップ
      </a>

      <header className="app-header">
        <h1>Motion Muse</h1>
        <span className="subtitle">音源解析 × モーション抽出 × キャラクター描画</span>

        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <label htmlFor="project-select" className="visually-hidden">
            プロジェクトを選択
          </label>
          <select
            id="project-select"
            value={project?.id ?? ''}
            onChange={(event) => selectProject(event.target.value)}
            style={{ width: 'auto', minWidth: 180 }}
          >
            {projects.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn"
            onClick={() => void addProject().catch((err) => toast.pushError(err))}
          >
            新規
          </button>
          <button
            type="button"
            className="btn btn-danger"
            disabled={projects.length <= 1 || !project}
            onClick={() => {
              if (!project) return;
              if (window.confirm(`プロジェクト「${project.name}」を削除します。よろしいですか？`)) {
                void removeProject(project.id).catch((err) => toast.pushError(err));
              }
            }}
          >
            削除
          </button>
        </div>
      </header>

      {!project ? (
        <main id="main-content" style={{ padding: 24 }}>
          <EmptyState title="プロジェクトがありません">
            「新規」ボタンからプロジェクトを作成してください。
          </EmptyState>
        </main>
      ) : (
        <main id="main-content" className="app-body">
          <div>
            <div className="panel" style={{ marginBottom: 16 }}>
              <label className="field-label" htmlFor="project-name">
                プロジェクト名
              </label>
              <input
                id="project-name"
                type="text"
                value={project.name}
                maxLength={120}
                onChange={(event) => updateProject({ name: event.target.value })}
              />
            </div>

            <div className="tablist" role="tablist" aria-label="編集ステップ">
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
                  className="tab"
                  aria-selected={tab === item.id}
                  aria-controls={`panel-${item.id}`}
                  tabIndex={tab === item.id ? 0 : -1}
                  onClick={() => setTab(item.id)}
                  onKeyDown={(event) => onTabKeyDown(event, index)}
                >
                  {item.label}
                </button>
              ))}
            </div>

            {TABS.map((item) => (
              <div
                key={item.id}
                role="tabpanel"
                id={`panel-${item.id}`}
                aria-labelledby={`tab-${item.id}`}
                hidden={tab !== item.id}
                tabIndex={0}
              >
                {tab === item.id && item.render()}
              </div>
            ))}
          </div>

          <PreviewStage />
        </main>
      )}
    </div>
  );
}
