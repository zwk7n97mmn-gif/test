/** DOM 生成・通知・ダイアログのユーティリティ（アクセシビリティの共通実装） */

/**
 * 要素を生成する。
 * @param {string} tag 'div.class#id' 形式のショートハンド可
 * @param {object} [props] class/text/html/attrs/dataset/on/style/その他プロパティ
 * @param {Array} [children]
 */
export function h(tag, props = {}, children = []) {
  const [name, ...rest] = tag.split(/(?=[.#])/);
  const el = document.createElement(name || 'div');
  for (const token of rest) {
    if (token.startsWith('.')) el.classList.add(token.slice(1));
    else if (token.startsWith('#')) el.id = token.slice(1);
  }
  applyProps(el, props);
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

/**
 * props を要素へ適用する。
 * 分岐はすべてブロックで囲むこと（else の結合先を取り違えると、
 * プロパティ指定が丸ごと無視されるという発見しにくい不具合になる）。
 */
export function applyProps(el, props) {
  for (const [key, value] of Object.entries(props || {})) {
    if (value === undefined || value === null) continue;
    if (key === 'class') {
      el.className = `${el.className} ${value}`.trim();
    } else if (key === 'text') {
      el.textContent = String(value);
    } else if (key === 'html') {
      el.innerHTML = value;
    } else if (key === 'style') {
      Object.assign(el.style, value);
    } else if (key === 'dataset') {
      Object.assign(el.dataset, value);
    } else if (key === 'on') {
      for (const [type, fn] of Object.entries(value)) {
        el.addEventListener(type, fn);
      }
    } else if (key === 'attrs') {
      for (const [name, attrValue] of Object.entries(value)) {
        if (attrValue !== null && attrValue !== undefined) el.setAttribute(name, String(attrValue));
      }
    } else if (key in el) {
      el[key] = value;
    } else {
      el.setAttribute(key, String(value));
    }
  }
  return el;
}

/**
 * 日本語入力（IME）に対応した input ハンドラを作る。
 *
 * 変換中も input イベントは発火するため、そのまま状態へ反映すると
 * 「かんじ」→「感じ」の途中経過が履歴に残り、確定前の文字列で処理が走ってしまう。
 * 変換確定（compositionend）まで通知を保留する。
 *
 * @param {(value:string, event:Event)=>void} onValue
 * @returns {object} h() の on に渡すハンドラ群
 */
export function imeSafeInput(onValue) {
  let composing = false;
  return {
    compositionstart: () => {
      composing = true;
    },
    compositionend: (event) => {
      composing = false;
      onValue(event.target.value, event);
    },
    input: (event) => {
      if (composing) return;
      onValue(event.target.value, event);
    },
  };
}

export const qs = (selector, root = document) => root.querySelector(selector);
export const qsa = (selector, root = document) => [...root.querySelectorAll(selector)];

/** ラベル付きフィールドを作る（label と入力を必ず紐付ける） */
export function field(labelText, control, { hint = '', id } = {}) {
  const controlId = id || control.id || `f_${Math.random().toString(36).slice(2, 9)}`;
  control.id = controlId;
  const hintId = `${controlId}-hint`;
  if (hint) control.setAttribute('aria-describedby', hintId);
  return h('div.field', {}, [
    h('label', { attrs: { for: controlId }, text: labelText }),
    control,
    hint ? h('p.hint', { id: hintId, text: hint }) : null,
  ]);
}

/** 数値スライダ＋数値表示 */
export function slider({ label, min, max, step, value, unit = '', format, onInput, hint }) {
  const output = h('output.slider-value', { text: format ? format(value) : `${value}${unit}` });
  const input = h('input', {
    type: 'range',
    min: String(min),
    max: String(max),
    step: String(step),
    value: String(value),
    on: {
      input: (e) => {
        const v = Number(e.target.value);
        output.textContent = format ? format(v) : `${v}${unit}`;
        onInput(v);
      },
    },
  });
  const wrapper = field(label, input, { hint });
  wrapper.querySelector('label').append(' ', output);
  wrapper.classList.add('field--slider');
  return { element: wrapper, input, output, set: (v) => { input.value = String(v); output.textContent = format ? format(v) : `${v}${unit}`; } };
}

/** トグルスイッチ（チェックボックス） */
export function toggle({ label, checked, onChange, hint }) {
  const input = h('input', {
    type: 'checkbox',
    checked: Boolean(checked),
    on: { change: (e) => onChange(e.target.checked) },
  });
  const wrapper = field(label, input, { hint });
  wrapper.classList.add('field--toggle');
  return { element: wrapper, input, set: (v) => { input.checked = Boolean(v); } };
}

/** セレクト */
export function select({ label, options, value, onChange, hint }) {
  const el = h('select', {
    on: { change: (e) => onChange(e.target.value) },
  }, options.map((o) => h('option', { value: o.value, text: o.label, selected: o.value === value })));
  return { element: field(label, el, { hint }), input: el, set: (v) => { el.value = v; } };
}

export function button(text, { onClick, variant = 'default', type = 'button', ...rest } = {}) {
  return h('button', {
    type,
    class: `btn btn--${variant}`,
    text,
    on: onClick ? { click: onClick } : {},
    ...rest,
  });
}

/** 空状態 */
export function emptyState(title, description, action) {
  return h('div.empty-state', { attrs: { role: 'note' } }, [
    h('p.empty-state__title', { text: title }),
    h('p.empty-state__desc', { text: description }),
    action || null,
  ]);
}

/** ローディング表示 */
export function loading(message, { determinate = false } = {}) {
  const bar = h('div.progress__bar');
  const wrapper = h('div.loading', { attrs: { role: 'status', 'aria-live': 'polite' } }, [
    h('p.loading__label', { text: message }),
    h('div.progress', {
      attrs: {
        role: 'progressbar',
        'aria-valuemin': '0',
        'aria-valuemax': '100',
        ...(determinate ? { 'aria-valuenow': '0' } : {}),
      },
    }, [bar]),
  ]);
  return {
    element: wrapper,
    setLabel(text) {
      wrapper.querySelector('.loading__label').textContent = text;
    },
    setRatio(ratio) {
      const pct = Math.round(Math.max(0, Math.min(1, ratio)) * 100);
      bar.style.width = `${pct}%`;
      wrapper.querySelector('.progress').setAttribute('aria-valuenow', String(pct));
    },
  };
}

/** エラー表示（role=alert で即時読み上げ） */
export function errorBox(message, action) {
  return h('div.alert.alert--error', { attrs: { role: 'alert' } }, [h('p', { text: message }), action || null]);
}

export function infoBox(message) {
  return h('div.alert.alert--info', { attrs: { role: 'status' } }, [h('p', { text: message })]);
}

/* ---------- ライブリージョン ---------- */
let politeRegion = null;
let assertiveRegion = null;

function ensureRegions() {
  if (!politeRegion) {
    politeRegion = h('div.sr-only', { attrs: { 'aria-live': 'polite', 'aria-atomic': 'true' } });
    document.body.append(politeRegion);
  }
  if (!assertiveRegion) {
    assertiveRegion = h('div.sr-only', { attrs: { role: 'alert', 'aria-live': 'assertive', 'aria-atomic': 'true' } });
    document.body.append(assertiveRegion);
  }
}

/** スクリーンリーダーへの通知 */
export function announce(message, { assertive = false } = {}) {
  ensureRegions();
  const region = assertive ? assertiveRegion : politeRegion;
  region.textContent = '';
  // 同一文言でも読み上げさせるため次フレームで設定する
  requestAnimationFrame(() => {
    region.textContent = String(message);
  });
}

/* ---------- トースト ---------- */
let toastHost = null;

export function toast(message, { type = 'info', duration = 5000 } = {}) {
  if (!toastHost) {
    toastHost = h('div.toast-host', { attrs: { 'aria-live': 'polite' } });
    document.body.append(toastHost);
  }
  const node = h(`div.toast.toast--${type}`, {}, [
    h('span.toast__text', { text: message }),
    h('button.toast__close', {
      type: 'button',
      attrs: { 'aria-label': '通知を閉じる' },
      text: '✕',
      on: { click: () => node.remove() },
    }),
  ]);
  toastHost.append(node);
  announce(message, { assertive: type === 'error' });
  if (duration > 0) setTimeout(() => node.remove(), duration);
  return node;
}

/* ---------- ダイアログ ---------- */

/**
 * モーダルダイアログ。Esc で閉じ、フォーカスをトラップし、閉じたら呼び出し元へフォーカスを戻す。
 * @returns {Promise<string|null>} 押されたアクションの value
 */
export function openDialog({ title, content, actions = [{ label: '閉じる', value: null }] }) {
  const opener = document.activeElement;
  const titleId = `dlg-title-${Math.random().toString(36).slice(2, 8)}`;
  return new Promise((resolve) => {
    const close = (value) => {
      document.removeEventListener('keydown', onKeydown, true);
      overlay.remove();
      if (opener instanceof HTMLElement) opener.focus();
      resolve(value);
    };
    const buttons = actions.map((action) =>
      button(action.label, {
        variant: action.variant || 'default',
        onClick: () => close(action.value ?? null),
      }),
    );
    const dialog = h('div.dialog', {
      attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
    }, [
      h('h2.dialog__title', { id: titleId, text: title }),
      h('div.dialog__body', {}, [content]),
      h('div.dialog__actions', {}, buttons),
    ]);
    const overlay = h('div.dialog-overlay', {
      on: {
        mousedown: (e) => {
          if (e.target === overlay) close(null);
        },
      },
    }, [dialog]);

    const focusables = () =>
      qsa('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])', dialog).filter(
        (el) => !el.disabled && el.offsetParent !== null,
      );

    const onKeydown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close(null);
        return;
      }
      if (event.key !== 'Tab') return;
      const list = focusables();
      if (!list.length) return;
      const first = list[0];
      const last = list[list.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeydown, true);
    document.body.append(overlay);
    (focusables()[0] || dialog).focus();
  });
}

/** 確認ダイアログ */
export async function confirmDialog(message, { confirmLabel = '実行', danger = false } = {}) {
  const result = await openDialog({
    title: '確認',
    content: h('p', { text: message }),
    actions: [
      { label: 'キャンセル', value: 'cancel' },
      { label: confirmLabel, value: 'ok', variant: danger ? 'danger' : 'primary' },
    ],
  });
  return result === 'ok';
}

/** クリップボードへコピー（失敗時はフォールバック） */
export async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = h('textarea', { value: text, style: { position: 'fixed', top: '-1000px' } });
    document.body.append(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    area.remove();
    return ok;
  }
}
