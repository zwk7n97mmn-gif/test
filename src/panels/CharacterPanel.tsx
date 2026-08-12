import {
  ACCESSORIES,
  ACCESSORY_LABELS,
  APPEARANCE_LIMITS,
  BODY_TYPES,
  BODY_TYPE_LABELS,
  EYE_STYLES,
  EYE_STYLE_LABELS,
  HAIR_STYLES,
  HAIR_STYLE_LABELS,
  OUTFITS,
  OUTFIT_LABELS,
  createDefaultAppearance,
  type CharacterAppearance,
} from '../lib/character/appearance';
import { useWorkspace } from '../state/workspace';
import { Checkbox, ColorField, EmptyState, Field, SelectField, Slider, useToast } from '../ui/primitives';

const toOptions = <T extends string>(values: readonly T[], labels: Record<T, string>) =>
  values.map((value) => ({ value, label: labels[value] }));

export function CharacterPanel() {
  const { project, updateProject, characters, saveCharacterPreset, removeCharacterPreset } = useWorkspace();
  const toast = useToast();
  if (!project) return null;

  const appearance = project.appearance;
  const set = (patch: Partial<CharacterAppearance>) =>
    updateProject((current) => ({ appearance: { ...current.appearance, ...patch } }));

  return (
    <div>
      <section className="panel">
        <h2>容姿</h2>
        <p className="panel-desc">
          ここで変更できるのは見た目だけです。モーションは別データなので、何をどう変えても動きは変わりません。
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
            label="髪型"
            value={appearance.hairStyle}
            options={toOptions(HAIR_STYLES, HAIR_STYLE_LABELS)}
            onChange={(hairStyle) => set({ hairStyle })}
          />
          <SelectField
            label="目の形"
            value={appearance.eyeStyle}
            options={toOptions(EYE_STYLES, EYE_STYLE_LABELS)}
            onChange={(eyeStyle) => set({ eyeStyle })}
          />
          <SelectField
            label="衣装"
            value={appearance.outfit}
            options={toOptions(OUTFITS, OUTFIT_LABELS)}
            onChange={(outfit) => set({ outfit })}
          />
          <SelectField
            label="アクセサリー"
            value={appearance.accessory}
            options={toOptions(ACCESSORIES, ACCESSORY_LABELS)}
            onChange={(accessory) => set({ accessory })}
          />
          <SelectField
            label="体型"
            value={appearance.bodyType}
            options={toOptions(BODY_TYPES, BODY_TYPE_LABELS)}
            onChange={(bodyType) => set({ bodyType })}
          />
        </div>

        <div className="grid-2">
          <ColorField label="髪色" value={appearance.hairColor} onChange={(hairColor) => set({ hairColor })} />
          <ColorField
            label="毛先の色"
            value={appearance.hairTipColor}
            onChange={(hairTipColor) => set({ hairTipColor })}
          />
          <ColorField label="瞳の色" value={appearance.eyeColor} onChange={(eyeColor) => set({ eyeColor })} />
          <ColorField label="肌の色" value={appearance.skinColor} onChange={(skinColor) => set({ skinColor })} />
          <ColorField label="衣装の色" value={appearance.outfitColor} onChange={(outfitColor) => set({ outfitColor })} />
          <ColorField
            label="差し色（襟・靴など）"
            value={appearance.outfitAccentColor}
            onChange={(outfitAccentColor) => set({ outfitAccentColor })}
          />
          <ColorField
            label="アクセサリーの色"
            value={appearance.accessoryColor}
            onChange={(accessoryColor) => set({ accessoryColor })}
          />
          <ColorField label="線の色" value={appearance.lineColor} onChange={(lineColor) => set({ lineColor })} />
        </div>

        <Slider
          label="頭の大きさ（頭身）"
          min={APPEARANCE_LIMITS.headScale.min}
          max={APPEARANCE_LIMITS.headScale.max}
          step={APPEARANCE_LIMITS.headScale.step}
          value={appearance.headScale}
          onChange={(headScale) => set({ headScale })}
          format={(v) => `${v.toFixed(2)}×`}
          hint="大きくするほどデフォルメ調になります"
        />
        <Slider
          label="脚の長さ"
          min={APPEARANCE_LIMITS.legLength.min}
          max={APPEARANCE_LIMITS.legLength.max}
          step={APPEARANCE_LIMITS.legLength.step}
          value={appearance.legLength}
          onChange={(legLength) => set({ legLength })}
          format={(v) => `${v.toFixed(2)}×`}
        />
        <Slider
          label="線の太さ"
          min={APPEARANCE_LIMITS.lineWidth.min}
          max={APPEARANCE_LIMITS.lineWidth.max}
          step={APPEARANCE_LIMITS.lineWidth.step}
          value={appearance.lineWidth}
          onChange={(lineWidth) => set({ lineWidth })}
          format={(v) => `${v.toFixed(2)}×`}
        />
        <Checkbox label="頬の赤みを付ける" checked={appearance.blush} onChange={(blush) => set({ blush })} />

        <div className="btn-row">
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              const preset = { ...appearance, id: crypto.randomUUID() };
              void saveCharacterPreset(preset)
                .then(() => toast.push('success', `「${preset.name}」をプリセットに保存しました。`))
                .catch((err) => toast.pushError(err));
            }}
          >
            プリセットとして保存
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
        <p className="panel-desc">保存した容姿をワンクリックで呼び出せます。</p>
        {characters.length === 0 ? (
          <EmptyState title="プリセットがありません">
            上の「プリセットとして保存」で現在の容姿を登録できます。
          </EmptyState>
        ) : (
          <ul className="item-list">
            {characters.map((preset) => (
              <li key={preset.id} className="item">
                <span
                  aria-hidden="true"
                  style={{
                    width: 22,
                    height: 22,
                    borderRadius: '50%',
                    background: preset.hairColor,
                    border: `2px solid ${preset.outfitColor}`,
                    flexShrink: 0,
                  }}
                />
                <div className="item-main">
                  <div className="item-title">{preset.name}</div>
                  <div className="item-meta">
                    {HAIR_STYLE_LABELS[preset.hairStyle]} ／ {OUTFIT_LABELS[preset.outfit]}
                  </div>
                </div>
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    set({ ...preset, id: appearance.id });
                    toast.push('success', `「${preset.name}」を適用しました。`);
                  }}
                >
                  適用
                </button>
                <button
                  type="button"
                  className="btn btn-danger"
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
