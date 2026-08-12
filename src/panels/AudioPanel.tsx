import { useRef, useState } from 'react';
import { analyzeAudioBlob } from '../lib/audio/analyzeClient';
import { decodeAudioBlob } from '../lib/audio/decode';
import type { AudioAnalysis } from '../lib/audio/types';
import type { AudioAsset } from '../lib/storage/db';
import { formatMetric, parseTrendList, TrendImportError, type TrendEntry } from '../lib/trend/import';
import { useCurrentAssets, useWorkspace } from '../state/workspace';
import { SECTION_LABELS } from '../components/Timeline';
import { Alert, EmptyState, ProgressBar, formatBytes, formatTime, useToast } from '../ui/primitives';

const MAX_AUDIO_BYTES = 60 * 1024 * 1024;

export function AudioPanel() {
  const { audioAssets, addAudio, updateAudio, removeAudio, updateProject, project, setAudioBuffer, trends, setTrends } =
    useWorkspace();
  const { audio, analysis } = useCurrentAssets();
  const toast = useToast();

  const [busy, setBusy] = useState<{ ratio: number; phase: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFile = async (file: File) => {
    setError(null);
    if (file.size > MAX_AUDIO_BYTES) {
      setError(`ファイルが大きすぎます（${formatBytes(file.size)}）。${formatBytes(MAX_AUDIO_BYTES)} 以下にしてください。`);
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy({ ratio: 0, phase: '読み込み中' });
    try {
      const { analysis: result, buffer } = await analyzeAudioBlob(
        file,
        (progress) => setBusy({ ratio: progress.ratio, phase: progress.phase }),
        controller.signal,
      );
      const asset: AudioAsset = {
        id: crypto.randomUUID(),
        name: file.name.replace(/\.[^.]+$/, ''),
        fileName: file.name,
        mimeType: file.type || 'audio/*',
        size: file.size,
        duration: result.duration,
        blob: file,
        analysis: result,
        createdAt: Date.now(),
      };
      setAudioBuffer(asset.id, buffer);
      await addAudio(asset);
      updateProject({ audioAssetId: asset.id, range: null });
      toast.push('success', `「${asset.name}」を解析しました（BPM ${result.bpm || '不明'}）`);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        toast.push('info', '解析を中止しました。');
      } else {
        setError(err instanceof Error ? err.message : '解析に失敗しました。');
        toast.pushError(err, '音源の解析に失敗しました。');
      }
    } finally {
      setBusy(null);
      abortRef.current = null;
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const selectAudio = async (asset: AudioAsset) => {
    updateProject({ audioAssetId: asset.id, range: null });
    // 再生・書き出しに使う AudioBuffer は保持していないことがあるので必要になった時点で復元する
    try {
      setAudioBuffer(asset.id, await decodeAudioBlob(asset.blob));
    } catch (err) {
      toast.pushError(err, '音源のデコードに失敗しました。');
    }
  };

  const applyHookRange = () => {
    if (!analysis?.hook) return;
    updateProject({ range: { start: analysis.hook.start, end: analysis.hook.end } });
    toast.push('success', 'サビ区間を書き出し範囲に設定しました。');
  };

  return (
    <div>
      <section className="panel">
        <h2>音源を読み込む</h2>
        <p className="panel-desc">
          手元の音声ファイルを解析して、BPM・ビート位置・曲構成（サビ）を自動検出します。
        </p>

        <label className="field-label" htmlFor="audio-file">
          音声ファイル（MP3 / M4A / WAV / OGG、{formatBytes(MAX_AUDIO_BYTES)} まで）
        </label>
        <input
          id="audio-file"
          ref={fileInputRef}
          type="file"
          accept="audio/*"
          disabled={busy !== null}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void handleFile(file);
          }}
        />

        {busy && (
          <div style={{ marginTop: 12 }}>
            <ProgressBar ratio={busy.ratio} label={`解析中: ${busy.phase}`} />
            <button type="button" className="btn" onClick={() => abortRef.current?.abort()} style={{ marginTop: 8 }}>
              中止
            </button>
          </div>
        )}

        {error && (
          <div style={{ marginTop: 12 }}>
            <Alert kind="error" title="読み込めませんでした">
              {error}
            </Alert>
          </div>
        )}

        <p className="legal-note">
          本ツールは TikTok などの外部サービスから音源や動画を自動取得しません。ご自身が利用権を持つ
          ファイルを読み込んでご利用ください。商用利用・二次配布の可否は各音源の権利表示に従ってください。
        </p>
      </section>

      <section className="panel">
        <h2>読み込み済みの音源（{audioAssets.length}）</h2>
        {audioAssets.length === 0 ? (
          <EmptyState title="まだ音源がありません">
            上のフォームから音声ファイルを選ぶと、ここに一覧が表示されます。
          </EmptyState>
        ) : (
          <ul className="item-list">
            {audioAssets.map((asset) => (
              <li key={asset.id} className="item" aria-current={asset.id === project?.audioAssetId}>
                <div className="item-main">
                  <div className="item-title">{asset.name}</div>
                  <div className="item-meta">
                    {formatTime(asset.duration)} ／ BPM {asset.analysis.bpm || '不明'} ／{' '}
                    {formatBytes(asset.size)}
                    {asset.trend ? ` ／ トレンド: ${asset.trend.title}` : ''}
                  </div>
                </div>
                <button
                  type="button"
                  className="btn"
                  onClick={() => void selectAudio(asset)}
                  disabled={asset.id === project?.audioAssetId}
                >
                  {asset.id === project?.audioAssetId ? '使用中' : '使う'}
                </button>
                <button
                  type="button"
                  className="btn btn-danger"
                  onClick={() => {
                    if (window.confirm(`「${asset.name}」を削除します。よろしいですか？`)) {
                      void removeAudio(asset.id).catch((err) => toast.pushError(err));
                    }
                  }}
                  aria-label={`${asset.name} を削除`}
                >
                  削除
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {analysis && <AnalysisSummary analysis={analysis} onApplyHook={applyHookRange} />}

      <TrendPanel
        trends={trends}
        setTrends={setTrends}
        onAttach={(entry) => {
          if (!audio) {
            toast.push('info', '先に音源を選択してください。');
            return;
          }
          void updateAudio({ ...audio, trend: entry })
            .then(() => toast.push('success', `「${entry.title}」を音源に紐づけました。`))
            .catch((err) => toast.pushError(err));
        }}
      />
    </div>
  );
}

function AnalysisSummary({
  analysis,
  onApplyHook,
}: {
  analysis: AudioAnalysis;
  onApplyHook: () => void;
}) {
  return (
    <section className="panel">
      <h2>解析結果</h2>
      <p className="panel-desc">この結果がビート同期・演出・サビ抽出に使われます。</p>

      {analysis.warnings.map((warning) => (
        <Alert kind="warning" key={warning}>
          {warning}
        </Alert>
      ))}

      <dl className="stat-grid">
        <div className="stat">
          <dt>BPM</dt>
          <dd>{analysis.bpm > 0 ? analysis.bpm.toFixed(1) : '—'}</dd>
        </div>
        <div className="stat">
          <dt>推定信頼度</dt>
          <dd>{(analysis.bpmConfidence * 100).toFixed(0)}%</dd>
        </div>
        <div className="stat">
          <dt>ビート数</dt>
          <dd>{analysis.beats.length}</dd>
        </div>
        <div className="stat">
          <dt>オンセット数</dt>
          <dd>{analysis.onsets.length}</dd>
        </div>
        <div className="stat">
          <dt>長さ</dt>
          <dd>{formatTime(analysis.duration)}</dd>
        </div>
      </dl>

      <h3 style={{ fontSize: 14, marginTop: 16, marginBottom: 8 }}>曲構成（{analysis.sections.length} 区間）</h3>
      {analysis.sections.length === 0 ? (
        <EmptyState title="区間を検出できませんでした">
          長さが足りないか、変化の少ない音源です。書き出し範囲は手動で設定してください。
        </EmptyState>
      ) : (
        <div className="scroll-y">
          <table className="data">
            <caption className="visually-hidden">検出された楽曲区間の一覧</caption>
            <thead>
              <tr>
                <th scope="col">区間</th>
                <th scope="col">開始</th>
                <th scope="col">長さ</th>
                <th scope="col">強さ</th>
              </tr>
            </thead>
            <tbody>
              {analysis.sections.map((section) => (
                <tr key={section.id}>
                  <td>
                    <span className={section.kind === 'hook' ? 'badge badge-hook' : 'badge'}>
                      {SECTION_LABELS[section.kind]}
                    </span>
                  </td>
                  <td>{formatTime(section.start)}</td>
                  <td>{formatTime(section.end - section.start)}</td>
                  <td>{(section.score * 100).toFixed(0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {analysis.hook && (
        <button type="button" className="btn btn-primary" style={{ marginTop: 12 }} onClick={onApplyHook}>
          サビ（{formatTime(analysis.hook.start)}〜{formatTime(analysis.hook.end)}）を書き出し範囲にする
        </button>
      )}
    </section>
  );
}

function TrendPanel({
  trends,
  setTrends,
  onAttach,
}: {
  trends: TrendEntry[];
  setTrends: (entries: TrendEntry[]) => void;
  onAttach: (entry: TrendEntry) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  const handleFile = async (file: File) => {
    setError(null);
    try {
      const text = await file.text();
      const entries = parseTrendList(text, file.name);
      setTrends(entries);
      toast.push('success', `${entries.length} 件のトレンド楽曲を読み込みました。`);
    } catch (err) {
      const message = err instanceof TrendImportError ? err.message : '読み込みに失敗しました。';
      setError(err instanceof TrendImportError && err.hint ? `${message} ${err.hint}` : message);
    }
  };

  return (
    <section className="panel">
      <h2>トレンド一覧の取り込み（任意）</h2>
      <p className="panel-desc">
        TikTok Creative Center などからご自身でエクスポートした人気楽曲リスト（CSV / JSON）を読み込み、
        制作した音源に紐づけて管理できます。
      </p>

      <label className="field-label" htmlFor="trend-file">
        CSV または JSON ファイル
      </label>
      <input
        id="trend-file"
        type="file"
        accept=".csv,.json,.tsv,text/csv,application/json"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void handleFile(file);
        }}
      />

      {error && (
        <div style={{ marginTop: 12 }}>
          <Alert kind="error" title="取り込めませんでした">
            {error}
          </Alert>
        </div>
      )}

      {trends.length === 0 ? (
        <div style={{ marginTop: 12 }}>
          <EmptyState title="トレンドリストは未読み込みです">
            「タイトル」列を含むファイルを読み込むと、ここに一覧が表示されます。
          </EmptyState>
        </div>
      ) : (
        <div className="scroll-y" style={{ marginTop: 12 }}>
          <table className="data">
            <caption className="visually-hidden">取り込んだトレンド楽曲一覧</caption>
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">タイトル</th>
                <th scope="col">アーティスト</th>
                <th scope="col">指標</th>
                <th scope="col">操作</th>
              </tr>
            </thead>
            <tbody>
              {trends.slice(0, 200).map((entry) => (
                <tr key={entry.id}>
                  <td>{entry.rank}</td>
                  <td>{entry.title}</td>
                  <td>{entry.artist ?? '—'}</td>
                  <td>{formatMetric(entry.metric)}</td>
                  <td>
                    <button type="button" className="btn" onClick={() => onAttach(entry)}>
                      紐づけ
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {trends.length > 200 && (
            <p className="field-hint">先頭 200 件のみ表示しています（読み込み済み {trends.length} 件）。</p>
          )}
        </div>
      )}
    </section>
  );
}
