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
import { useRef, useState } from 'react';
import { AVATAR_EXTENSIONS, AvatarLoadError, loadAvatar, MAX_AVATAR_BYTES } from '../lib/character/avatar';
import { disposeAvatarRig } from '../lib/character/avatarRetarget';
import type { AvatarAsset } from '../lib/storage/db';
import { useWorkspace } from '../state/workspace';
import {
  Alert,
  Checkbox,
  ColorField,
  EmptyState,
  Field,
  SelectField,
  Slider,
  formatBytes,
  useToast,
} from '../ui/primitives';

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

  const usingAvatar = Boolean(project.avatarId);

  return (
    <div>
      <AvatarSection />

      {usingAvatar ? (
        <section className="panel">
          <h2>内蔵キャラクター</h2>
          <p className="panel-desc">
            いま読み込んだアバターを使用しています。下の設定は内蔵キャラクター用のもので、
            アバター使用中は反映されません。
          </p>
        </section>
      ) : null}

      <section className="panel" aria-disabled={usingAvatar} style={usingAvatar ? { opacity: 0.55 } : undefined}>
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

/**
 * 外部アバター（VRM / glTF）の読み込みと選択。
 *
 * 実写に近い見た目にしたい場合は、この形式のモデルを読み込むのが唯一の実用的な方法。
 * 本ツールは骨の「向き」だけを与えるので、体型・質感・衣装はモデル側のものがそのまま出る。
 */
function AvatarSection() {
  const { project, updateProject, avatars, addAvatar, removeAvatar, avatarStatus, avatarError, avatarRig } =
    useWorkspace();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  if (!project) return null;

  const handleFile = async (file: File) => {
    setError(null);
    setBusy(true);
    try {
      // 読み込めるモデルかをこの場で検証してから保存する（壊れたデータを残さない）
      const loaded = await loadAvatar(file, file.name);
      const asset: AvatarAsset = {
        id: crypto.randomUUID(),
        name: file.name.replace(/\.[^.]+$/, ''),
        fileName: file.name,
        size: file.size,
        kind: loaded.kind,
        boneCount: loaded.boneCount,
        blob: file,
        createdAt: Date.now(),
      };
      disposeAvatarRig(loaded.rig); // 検証用に読んだものは破棄し、選択時に読み直す
      await addAvatar(asset);
      updateProject({ avatarId: asset.id, avatarFlipFacing: null });
      toast.push(
        'success',
        `「${asset.name}」を読み込みました（${loaded.boneCount} ボーン / ${
          loaded.mappingSource === 'vrm-humanoid' ? 'VRM humanoid' : 'ボーン名から推定'
        }）`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : 'アバターを読み込めませんでした。';
      const hint = err instanceof AvatarLoadError ? err.hint : undefined;
      setError(hint ? `${message} ${hint}` : message);
      toast.pushError(err, 'アバターを読み込めませんでした。');
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  return (
    <section className="panel">
      <h2>3Dアバター</h2>
      <p className="panel-desc">
        VRM / glTF のモデルを読み込むと、そのアバターがモーションで動きます。写真のような
        リアルな見た目にしたい場合はこちらを使ってください。
      </p>

      <label className="btn btn-primary btn-block" style={{ cursor: 'pointer' }}>
        {busy ? '読み込み中…' : '🧑 アバターを読み込む'}
        <input
          ref={inputRef}
          type="file"
          accept={AVATAR_EXTENSIONS.join(',')}
          className="visually-hidden"
          disabled={busy}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void handleFile(file);
          }}
        />
      </label>
      <p className="field-hint">
        .vrm / .glb / .gltf（{formatBytes(MAX_AVATAR_BYTES)} まで）。テクスチャを含む .glb か .vrm を推奨します。
      </p>

      {error && (
        <div style={{ marginTop: 12 }}>
          <Alert kind="error" title="読み込めませんでした">
            {error}
          </Alert>
        </div>
      )}

      {avatarStatus === 'loading' && (
        <p className="field-hint" role="status">
          <span className="spinner" aria-hidden="true" style={{ verticalAlign: 'middle', marginRight: 8 }} />
          アバターを読み込んでいます…
        </p>
      )}
      {avatarStatus === 'error' && avatarError && (
        <Alert kind="error" title="アバターを表示できません">
          {avatarError}
        </Alert>
      )}

      {avatarRig && avatarRig.warnings.length > 0 && (
        <Alert kind="warning" title="一部のボーンが対応付けできませんでした">
          {avatarRig.warnings.join(' / ')}
        </Alert>
      )}

      {avatars.length === 0 ? (
        <div style={{ marginTop: 12 }}>
          <EmptyState title="アバターは未読み込みです">
            読み込むまでは内蔵キャラクターが表示されます。
          </EmptyState>
        </div>
      ) : (
        <ul className="item-list" style={{ marginTop: 12 }}>
          <li className="item" aria-current={!project.avatarId}>
            <div className="item-main">
              <div className="item-title">内蔵キャラクター</div>
              <div className="item-meta">下の設定で体型・服装を変更できます</div>
            </div>
            <button
              type="button"
              className="btn btn-small"
              disabled={!project.avatarId}
              onClick={() => updateProject({ avatarId: null })}
            >
              {!project.avatarId ? '使用中' : '使う'}
            </button>
          </li>
          {avatars.map((asset) => (
            <li key={asset.id} className="item" aria-current={asset.id === project.avatarId}>
              <div className="item-main">
                <div className="item-title">{asset.name}</div>
                <div className="item-meta">
                  {asset.kind.toUpperCase()} ／ {formatBytes(asset.size)} ／ {asset.boneCount} ボーン
                </div>
              </div>
              <button
                type="button"
                className="btn btn-small"
                disabled={asset.id === project.avatarId}
                onClick={() => updateProject({ avatarId: asset.id, avatarFlipFacing: null })}
              >
                {asset.id === project.avatarId ? '使用中' : '使う'}
              </button>
              <button
                type="button"
                className="btn btn-small btn-danger"
                aria-label={`${asset.name} を削除`}
                onClick={() => {
                  if (window.confirm(`アバター「${asset.name}」を削除します。よろしいですか？`)) {
                    void removeAvatar(asset.id).catch((err) => toast.pushError(err));
                  }
                }}
              >
                削除
              </button>
            </li>
          ))}
        </ul>
      )}

      {project.avatarId && (
        <div style={{ marginTop: 12 }}>
          <Checkbox
            label="正面の向きを反転する（後ろを向いてしまう場合）"
            checked={project.avatarFlipFacing ?? avatarRig?.facesBackward ?? false}
            onChange={(flip) => updateProject({ avatarFlipFacing: flip })}
          />
        </div>
      )}
    </section>
  );
}
