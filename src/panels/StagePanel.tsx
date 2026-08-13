import {
  BACKGROUND_KINDS,
  BACKGROUND_LABELS,
  CANVAS_PRESETS,
  type BackgroundKind,
  type CanvasPresetId,
} from '../lib/project/types';
import { contrastRatio } from '../lib/util/color';
import { useCurrentAssets, useWorkspace } from '../state/workspace';
import { Alert, Checkbox, ColorField, Field, SelectField, Slider, formatTime, useToast } from '../ui/primitives';

export function StagePanel() {
  const { project, updateProject } = useWorkspace();
  const { clip, analysis } = useCurrentAssets();
  const toast = useToast();
  if (!project) return null;

  const { timing, background, effects, caption } = project;
  const duration = analysis?.duration ?? clip?.duration ?? 0;
  const bpm = analysis?.bpm ?? 0;
  const captionContrast = contrastRatio(caption.color, caption.backgroundColor);

  const setTiming = (patch: Partial<typeof timing>) =>
    updateProject((current) => ({ timing: { ...current.timing, ...patch } }));

  return (
    <div>
      <section className="panel">
        <h2>出力設定</h2>
        <div className="grid-2">
          <SelectField
            label="サイズ"
            value={project.canvas.presetId}
            options={CANVAS_PRESETS.map((preset) => ({ value: preset.id, label: preset.label }))}
            onChange={(presetId: CanvasPresetId) =>
              updateProject((current) => ({ canvas: { ...current.canvas, presetId } }))
            }
          />
          <SelectField
            label="フレームレート"
            value={String(project.canvas.fps)}
            options={[
              { value: '24', label: '24 fps' },
              { value: '30', label: '30 fps' },
              { value: '60', label: '60 fps' },
            ]}
            onChange={(fps) => updateProject((current) => ({ canvas: { ...current.canvas, fps: Number(fps) } }))}
          />
        </div>

        <Field
          label="書き出し範囲"
          value={project.range ? `${formatTime(project.range.start)} 〜 ${formatTime(project.range.end)}` : '全体'}
          hint="「音源」タブでサビ区間をワンクリック指定できます。"
        >
          {({ id }) => (
            <div className="btn-row" id={id}>
              <button
                type="button"
                className="btn"
                disabled={!project.range}
                onClick={() => updateProject({ range: null })}
              >
                全体に戻す
              </button>
              {duration > 0 && (
                <button
                  type="button"
                  className="btn"
                  onClick={() =>
                    updateProject({ range: { start: 0, end: Math.min(duration, 15) } })
                  }
                >
                  先頭15秒
                </button>
              )}
            </div>
          )}
        </Field>
      </section>

      <section className="panel">
        <h2>モーションの当て方</h2>
        <p className="panel-desc">
          抽出したモーションを、楽曲のどのタイミングで再生するかを決めます。
        </p>

        <SelectField
          label="同期モード"
          value={timing.mode}
          options={[
            { value: 'sync', label: 'ビート同期（推奨）' },
            { value: 'original', label: '元の速度のまま' },
          ]}
          onChange={(mode) => setTiming({ mode })}
          hint={
            bpm > 0
              ? `検出BPM ${bpm.toFixed(1)} を基準に伸縮します。`
              : 'BPM未検出のため、ビート同期を選んでも元の速度で再生されます。'
          }
        />

        {timing.mode === 'sync' && (
          <>
            <Slider
              label="ループの長さ"
              min={1}
              max={64}
              step={1}
              value={timing.loopBeats}
              onChange={(loopBeats) => setTiming({ loopBeats })}
              format={(v) => `${v} 拍（${(v / 4).toFixed(2)} 小節）`}
              hint={
                clip && bpm > 0
                  ? `クリップ ${clip.duration.toFixed(2)} 秒 → 再生速度 ${(
                      clip.duration / (timing.loopBeats * (60 / bpm))
                    ).toFixed(2)}×`
                  : undefined
              }
            />
            <Slider
              label="開始オフセット"
              min={-8}
              max={8}
              step={0.25}
              value={timing.offsetBeats}
              onChange={(offsetBeats) => setTiming({ offsetBeats })}
              format={(v) => `${v > 0 ? '+' : ''}${v} 拍`}
            />
          </>
        )}

        <Checkbox label="繰り返し再生する" checked={timing.loop} onChange={(loop) => setTiming({ loop })} />
        <Checkbox label="左右反転して表示" checked={timing.mirror} onChange={(mirror) => setTiming({ mirror })} />

        <Slider
          label="被写体の大きさ"
          min={0.5}
          max={1.5}
          step={0.01}
          value={timing.scale}
          onChange={(scale) => setTiming({ scale })}
          format={(v) => `${(v * 100).toFixed(0)}%`}
        />
        <Slider
          label="足元の位置"
          min={0.4}
          max={0.98}
          step={0.01}
          value={timing.anchorY}
          onChange={(anchorY) => setTiming({ anchorY })}
          format={(v) => `画面上端から ${(v * 100).toFixed(0)}%`}
        />
        <Slider
          label="元動画の移動量の反映"
          min={0}
          max={1}
          step={0.01}
          value={timing.rootMotion}
          onChange={(rootMotion) => setTiming({ rootMotion })}
          format={(v) => `${(v * 100).toFixed(0)}%`}
          hint="0にすると画面中央に固定されます。"
        />
      </section>

      <section className="panel">
        <h2>背景と演出</h2>
        <SelectField
          label="背景"
          value={background.kind}
          options={BACKGROUND_KINDS.map((kind: BackgroundKind) => ({ value: kind, label: BACKGROUND_LABELS[kind] }))}
          onChange={(kind) => updateProject((current) => ({ background: { ...current.background, kind } }))}
        />
        <div className="grid-2">
          <ColorField
            label="背景色 1"
            value={background.colorA}
            onChange={(colorA) => updateProject((current) => ({ background: { ...current.background, colorA } }))}
          />
          <ColorField
            label="背景色 2"
            value={background.colorB}
            onChange={(colorB) => updateProject((current) => ({ background: { ...current.background, colorB } }))}
          />
        </div>
        <Slider
          label="背景のビート反応"
          min={0}
          max={1}
          step={0.01}
          value={background.beatReactivity}
          onChange={(beatReactivity) =>
            updateProject((current) => ({ background: { ...current.background, beatReactivity } }))
          }
          format={(v) => `${(v * 100).toFixed(0)}%`}
          disabled={!analysis || analysis.beats.length === 0}
          hint={!analysis || analysis.beats.length === 0 ? 'ビート未検出のため無効です。' : undefined}
        />

        {(['zoomPunch', 'particles', 'bassPulse'] as const).map((key) => (
          <Slider
            key={key}
            label={
              {
                zoomPunch: 'ズームパンチ',
                particles: 'パーティクル',
                bassPulse: '低音の床発光',
              }[key]
            }
            min={0}
            max={1}
            step={0.01}
            value={effects[key]}
            onChange={(value) => updateProject((current) => ({ effects: { ...current.effects, [key]: value } }))}
            format={(v) => `${(v * 100).toFixed(0)}%`}
          />
        ))}
      </section>

      <section className="panel">
        <h2>テロップ</h2>
        <Checkbox
          label="テロップを表示する"
          checked={caption.enabled}
          onChange={(enabled) => updateProject((current) => ({ caption: { ...current.caption, enabled } }))}
        />
        <Field label="テキスト" hint="改行できます。長い場合は自動で折り返し、最大6行まで表示します。">
          {({ id }) => (
            <textarea
              id={id}
              value={caption.text}
              maxLength={500}
              disabled={!caption.enabled}
              onChange={(event) =>
                updateProject((current) => ({ caption: { ...current.caption, text: event.target.value } }))
              }
            />
          )}
        </Field>
        <p className="field-hint">{caption.text.length} / 500 文字</p>

        <div className="grid-2">
          <ColorField
            label="文字色"
            value={caption.color}
            onChange={(color) => updateProject((current) => ({ caption: { ...current.caption, color } }))}
          />
          <ColorField
            label="縁取り・帯の色"
            value={caption.backgroundColor}
            onChange={(backgroundColor) =>
              updateProject((current) => ({ caption: { ...current.caption, backgroundColor } }))
            }
          />
        </div>

        {caption.enabled && captionContrast < 4.5 && (
          <Alert kind="warning" title="テロップが読みにくい配色です">
            文字色と帯の色のコントラスト比が {captionContrast.toFixed(2)}:1 です。4.5:1 以上を推奨します。
          </Alert>
        )}

        <Slider
          label="文字サイズ"
          min={20}
          max={140}
          step={1}
          value={caption.fontSize}
          onChange={(fontSize) => updateProject((current) => ({ caption: { ...current.caption, fontSize } }))}
          format={(v) => `${v}px`}
          disabled={!caption.enabled}
        />
        <Slider
          label="縦位置"
          min={0.02}
          max={0.95}
          step={0.01}
          value={caption.position}
          onChange={(position) => updateProject((current) => ({ caption: { ...current.caption, position } }))}
          format={(v) => `${(v * 100).toFixed(0)}%`}
          disabled={!caption.enabled}
        />

        <button
          type="button"
          className="btn"
          onClick={() => {
            updateProject((current) => ({
              caption: { ...current.caption, color: '#ffffff', backgroundColor: '#000000' },
            }));
            toast.push('success', '読みやすい配色（白文字 / 黒縁）に戻しました。');
          }}
        >
          読みやすい配色に戻す
        </button>
      </section>
    </div>
  );
}
