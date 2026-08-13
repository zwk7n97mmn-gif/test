import {
  APPEARANCE_LIMITS,
  BUILDS,
  BUILD_LABELS,
  HAIR_STYLES,
  HAIR_STYLE_LABELS,
  OUTFITS,
  OUTFIT_LABELS,
  createDefaultAppearance,
  type CharacterAppearance,
} from '../lib/character/appearance';
import { useWorkspace } from '../state/workspace';
import { ColorField, EmptyState, Field, SelectField, Slider, useToast } from '../ui/primitives';

const toOptions = <T extends string>(values: readonly T[], labels: Record<T, string>) =>
  values.map((value) => ({ value, label: labels[value] }));

/** よく使う肌の色。1タップで選べるようにする。 */
const SKIN_SWATCHES = ['#f6d9c4', '#e8b89b', '#d09a76', '#a9714c', '#7d4f33', '#4f2f20'];

export function CharacterPanel() {
  const { project, updateProject, characters, saveCharacterPreset, removeCharacterPreset } = useWorkspace();
  const toast = useToast();
  if (!project) return null;

  const appearance = project.appearance;
  const set = (patch: Partial<CharacterAppearance>) =>
    updateProject((current) => ({ appearance: { ...current.appearance, ...patch } }));
  const L = APPEARANCE_LIMITS;

  return (
    <div>
      <section className="panel">
        <h2>容姿</h2>
        <p className="panel-desc">
          変更できるのは見た目だけです。モーションは別データなので、何をどう変えても動きは変わりません。
        </p>

        <Field label="キャラクター名">
          {({ id }) => (
            <input
              id={id}
              type="text"
              value={appearance.name}
              maxLength={60}
              onChange={(event) => set({ name: event.target.value })}
            />
          )}
        </Field>

        <div className="grid-2">
          <SelectField
            label="体型"
            value={appearance.build}
            options={toOptions(BUILDS, BUILD_LABELS)}
            onChange={(build) => set({ build })}
          />
          <SelectField
            label="髪型"
            value={appearance.hairStyle}
            options={toOptions(HAIR_STYLES, HAIR_STYLE_LABELS)}
            onChange={(hairStyle) => set({ hairStyle })}
          />
        </div>

        <SelectField
          label="服装"
          value={appearance.outfit}
          options={toOptions(OUTFITS, OUTFIT_LABELS)}
          onChange={(outfit) => set({ outfit })}
        />

        <Field label="肌の色" value={appearance.skinTone.toUpperCase()}>
          {({ id }) => (
            <div id={id} className="btn-row" role="group" aria-label="肌の色のプリセット">
              {SKIN_SWATCHES.map((color) => (
                <button
                  key={color}
                  type="button"
                  className="btn btn-small"
                  aria-label={`肌の色 ${color}`}
                  aria-pressed={appearance.skinTone.toLowerCase() === color}
                  onClick={() => set({ skinTone: color })}
                  style={{
                    background: color,
                    width: 44,
                    minWidth: 44,
                    borderColor: appearance.skinTone.toLowerCase() === color ? 'var(--accent)' : 'var(--border)',
                    borderWidth: appearance.skinTone.toLowerCase() === color ? 3 : 1,
                  }}
                />
              ))}
            </div>
          )}
        </Field>

        <div className="grid-2">
          <ColorField label="肌（詳細指定）" value={appearance.skinTone} onChange={(skinTone) => set({ skinTone })} />
          <ColorField label="髪の色" value={appearance.hairColor} onChange={(hairColor) => set({ hairColor })} />
          <ColorField label="瞳の色" value={appearance.eyeColor} onChange={(eyeColor) => set({ eyeColor })} />
          <ColorField label="トップス" value={appearance.topColor} onChange={(topColor) => set({ topColor })} />
          <ColorField label="ボトムス" value={appearance.bottomColor} onChange={(bottomColor) => set({ bottomColor })} />
          <ColorField label="靴" value={appearance.shoeColor} onChange={(shoeColor) => set({ shoeColor })} />
        </div>
      </section>

      <section className="panel">
        <h2>プロポーション</h2>
        <p className="panel-desc">既定値でおよそ 7 頭身です。</p>

        <Slider
          label="頭の大きさ"
          min={L.headScale.min}
          max={L.headScale.max}
          step={L.headScale.step}
          value={appearance.headScale}
          onChange={(headScale) => set({ headScale })}
          format={(v) => `${v.toFixed(2)}×`}
        />
        <Slider
          label="脚の長さ"
          min={L.legLength.min}
          max={L.legLength.max}
          step={L.legLength.step}
          value={appearance.legLength}
          onChange={(legLength) => set({ legLength })}
          format={(v) => `${v.toFixed(2)}×`}
        />
        <Slider
          label="肩幅"
          min={L.shoulderWidth.min}
          max={L.shoulderWidth.max}
          step={L.shoulderWidth.step}
          value={appearance.shoulderWidth}
          onChange={(shoulderWidth) => set({ shoulderWidth })}
          format={(v) => `${v.toFixed(2)}×`}
        />
        <Slider
          label="手足の太さ"
          min={L.limbThickness.min}
          max={L.limbThickness.max}
          step={L.limbThickness.step}
          value={appearance.limbThickness}
          onChange={(limbThickness) => set({ limbThickness })}
          format={(v) => `${v.toFixed(2)}×`}
        />
        <Slider
          label="肌のツヤ"
          min={L.skinGloss.min}
          max={L.skinGloss.max}
          step={L.skinGloss.step}
          value={appearance.skinGloss}
          onChange={(skinGloss) => set({ skinGloss })}
          format={(v) => `${(v * 100).toFixed(0)}%`}
        />

        <div className="btn-row">
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              const preset = { ...appearance, id: crypto.randomUUID() };
              void saveCharacterPreset(preset)
                .then(() => toast.push('success', `「${preset.name}」を保存しました。`))
                .catch((err) => toast.pushError(err));
            }}
          >
            プリセットに保存
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => set({ ...createDefaultAppearance(), id: appearance.id, name: appearance.name })}
          >
            既定値に戻す
          </button>
        </div>
      </section>

      <section className="panel">
        <h2>プリセット（{characters.length}）</h2>
        {characters.length === 0 ? (
          <EmptyState title="プリセットがありません">
            「プリセットに保存」で現在の容姿を登録できます。
          </EmptyState>
        ) : (
          <ul className="item-list">
            {characters.map((preset) => (
              <li key={preset.id} className="item">
                <div className="item-main" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span
                    aria-hidden="true"
                    style={{
                      width: 26,
                      height: 26,
                      borderRadius: '50%',
                      background: preset.skinTone,
                      border: `3px solid ${preset.hairColor}`,
                      flexShrink: 0,
                    }}
                  />
                  <div style={{ minWidth: 0 }}>
                    <div className="item-title">{preset.name}</div>
                    <div className="item-meta">
                      {BUILD_LABELS[preset.build]} ／ {HAIR_STYLE_LABELS[preset.hairStyle]} ／{' '}
                      {OUTFIT_LABELS[preset.outfit]}
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  className="btn btn-small"
                  onClick={() => {
                    set({ ...preset, id: appearance.id });
                    toast.push('success', `「${preset.name}」を適用しました。`);
                  }}
                >
                  適用
                </button>
                <button
                  type="button"
                  className="btn btn-small btn-danger"
                  aria-label={`プリセット ${preset.name} を削除`}
                  onClick={() => {
                    if (window.confirm(`プリセット「${preset.name}」を削除します。よろしいですか？`)) {
                      void removeCharacterPreset(preset.id).catch((err) => toast.pushError(err));
                    }
                  }}
                >
                  削除
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
