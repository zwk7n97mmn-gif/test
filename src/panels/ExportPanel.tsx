import { useMemo, useRef, useState } from 'react';
import { decodeAudioBlob } from '../lib/audio/decode';
import {
  checkExportSupport,
  downloadBlob,
  exportVideo,
  pickMimeType,
  safeFileName,
} from '../lib/export/recorder';
import { canvasSize } from '../lib/project/types';
import { effectiveRange } from '../lib/render/composer';
import { useCurrentAssets, useWorkspace } from '../state/workspace';
import { Alert, Checkbox, EmptyState, ProgressBar, formatBytes, formatTime, useToast } from '../ui/primitives';

/** Web Share API level 2（ファイル共有）が使えるか。 */
function canShare(file: File): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] });
}

/** 共有シートを開く。成功したら true、非対応・キャンセル時は false。 */
async function shareFile(file: File): Promise<boolean> {
  if (!canShare(file)) return false;
  try {
    await navigator.share({ files: [file], title: file.name });
    return true;
  } catch {
    // ユーザーがキャンセルした場合もここに来る。保存へのフォールバックは呼び出し側で判断する。
    return false;
  }
}

export function ExportPanel() {
  const { project, getAudioBuffer, setAudioBuffer, storage, setRenderBusy, avatarRig } = useWorkspace();
  const { clip, audio, analysis } = useCurrentAssets();
  const toast = useToast();

  const [progress, setProgress] = useState<{ ratio: number; message: string } | null>(null);
  const [result, setResult] = useState<{ blob: Blob; fileName: string; file: File } | null>(null);
  const [monitor, setMonitor] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const support = useMemo(() => checkExportSupport(), []);
  const mime = useMemo(() => pickMimeType(), []);
  if (!project) return null;

  const range = effectiveRange(project, analysis, clip);
  const size = canvasSize(project.canvas.presetId);
  const totalSeconds = Math.max(0, range.end - range.start);

  const runExport = async () => {
    if (!clip) return;
    setResult(null);
    const controller = new AbortController();
    abortRef.current = controller;
    setProgress({ ratio: 0, message: '準備中…' });
    // WebGL コンテキストは 1 つを共有しているため、書き出し中はプレビューを止める
    setRenderBusy(true);
    try {
      let buffer = audio ? getAudioBuffer(audio.id) : null;
      if (audio && !buffer) {
        buffer = await decodeAudioBlob(audio.blob);
        setAudioBuffer(audio.id, buffer);
      }
      const output = await exportVideo({
        project,
        clip,
        analysis,
        avatar: avatarRig,
        audioBuffer: buffer,
        monitor,
        signal: controller.signal,
        onProgress: (update) => setProgress({ ratio: update.ratio, message: update.message }),
      });
      const fileName = safeFileName(project.name, output.extension);
      const file = new File([output.blob], fileName, { type: output.mimeType });
      setResult({ blob: output.blob, fileName, file });
      toast.push('success', `書き出しが完了しました（${formatBytes(output.blob.size)}）`);
      // スマートフォンでは共有シートから直接 SNS へ渡せるようにする
      if (!(await shareFile(file))) downloadBlob(output.blob, fileName);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        toast.push('info', '書き出しを中止しました。');
      } else {
        toast.pushError(err, '書き出しに失敗しました。');
      }
    } finally {
      setProgress(null);
      abortRef.current = null;
      setRenderBusy(false);
    }
  };

  return (
    <div>
      <section className="panel">
        <h2>書き出し</h2>
        <p className="panel-desc">
          プレビューと同じ内容を動画ファイルとして保存します。音声と確実に同期させるため、
          実時間で録画します（30秒の動画なら約30秒かかります）。
        </p>

        {!support.supported && (
          <Alert kind="error" title="このブラウザでは書き出せません">
            {support.reason}
          </Alert>
        )}

        {!clip && (
          <Alert kind="warning" title="モーションが未設定です">
            「モーション」タブで動画からモーションを抽出すると書き出せるようになります。
          </Alert>
        )}

        {!audio && clip && (
          <Alert kind="info" title="音源が未設定です">
            このまま書き出すと無音の映像になります。「音源」タブで音声ファイルを読み込んでください。
          </Alert>
        )}

        <dl className="stat-grid">
          <div className="stat">
            <dt>解像度</dt>
            <dd style={{ fontSize: 16 }}>
              {size.width}×{size.height}
            </dd>
          </div>
          <div className="stat">
            <dt>フレームレート</dt>
            <dd style={{ fontSize: 16 }}>{project.canvas.fps} fps</dd>
          </div>
          <div className="stat">
            <dt>長さ</dt>
            <dd style={{ fontSize: 16 }}>{formatTime(totalSeconds)}</dd>
          </div>
          <div className="stat">
            <dt>形式</dt>
            <dd style={{ fontSize: 16 }}>{mime ? mime.extension.toUpperCase() : '—'}</dd>
          </div>
        </dl>

        <div style={{ marginTop: 12 }}>
          <Checkbox label="書き出し中に音を鳴らす（確認用）" checked={monitor} onChange={setMonitor} />
        </div>

        <div className="btn-row">
          <button
            type="button"
            className="btn btn-primary"
            disabled={!support.supported || !clip || progress !== null}
            onClick={() => void runExport()}
          >
            動画を書き出す
          </button>
          {progress && (
            <button type="button" className="btn" onClick={() => abortRef.current?.abort()}>
              中止
            </button>
          )}
        </div>

        {progress && (
          <div style={{ marginTop: 12 }}>
            <ProgressBar ratio={progress.ratio} label={progress.message} />
            <Alert kind="warning" title="書き出し中はこのタブを表示したままにしてください">
              タブを非表示にすると描画が止まり、動画が途中で途切れることがあります。
            </Alert>
          </div>
        )}

        {result && (
          <div style={{ marginTop: 12 }}>
            <Alert kind="info" title="書き出しが完了しました">
              {result.fileName}（{formatBytes(result.blob.size)}）
            </Alert>
            <div className="btn-row">
              {canShare(result.file) && (
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => {
                    void shareFile(result.file).then((ok) => {
                      if (!ok) toast.push('info', '共有できなかったため、保存に切り替えてください。');
                    });
                  }}
                >
                  📤 共有する
                </button>
              )}
              <button type="button" className="btn" onClick={() => downloadBlob(result.blob, result.fileName)}>
                端末に保存
              </button>
            </div>
          </div>
        )}

        {mime?.extension === 'webm' && (
          <p className="field-hint" style={{ marginTop: 12 }}>
            このブラウザでは WebM 形式で書き出されます。MP4 が必要な場合は Safari で開くか、
            書き出し後に変換ツールをご利用ください。
          </p>
        )}
      </section>

      <section className="panel">
        <h2>保存容量</h2>
        {storage ? (
          <>
            <ProgressBar
              ratio={storage.quota > 0 ? storage.usage / storage.quota : 0}
              label={`${formatBytes(storage.usage)} / ${formatBytes(storage.quota)} 使用中`}
            />
            {storage.quota > 0 && storage.usage / storage.quota > 0.8 && (
              <Alert kind="warning" title="保存容量が残りわずかです">
                不要な音源やモーションを削除してください。上限に達すると保存に失敗します。
              </Alert>
            )}
          </>
        ) : (
          <EmptyState title="このブラウザでは容量を取得できません">
            保存に失敗する場合は、不要なデータを削除してお試しください。
          </EmptyState>
        )}
      </section>
    </div>
  );
}
