import {
  Component,
  createContext,
  useCallback,
  useContext,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

// ---------------------------------------------------------------------------
// フォーム部品（label / aria-describedby を必ず結び付ける）
// ---------------------------------------------------------------------------

interface FieldProps {
  label: string;
  hint?: string;
  error?: string;
  value?: ReactNode;
  children: (props: { id: string; describedBy: string | undefined; invalid: boolean }) => ReactNode;
}

export function Field({ label, hint, error, value, children }: FieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ') || undefined;

  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        <span>{label}</span>
        {value !== undefined && <span className="field-value">{value}</span>}
      </label>
      {children({ id, describedBy, invalid: Boolean(error) })}
      {hint && (
        <p className="field-hint" id={hintId}>
          {hint}
        </p>
      )}
      {error && (
        <p className="field-error" id={errorId} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

interface SliderProps {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (value: number) => void;
  format?: (value: number) => string;
  hint?: string;
  disabled?: boolean;
}

export function Slider({ label, min, max, step, value, onChange, format, hint, disabled }: SliderProps) {
  return (
    <Field label={label} hint={hint} value={format ? format(value) : value.toFixed(2)}>
      {({ id, describedBy }) => (
        <input
          id={id}
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          disabled={disabled}
          aria-describedby={describedBy}
          onChange={(event) => onChange(Number(event.target.value))}
        />
      )}
    </Field>
  );
}

interface SelectFieldProps<T extends string> {
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (value: T) => void;
  hint?: string;
  disabled?: boolean;
}

export function SelectField<T extends string>({
  label,
  value,
  options,
  onChange,
  hint,
  disabled,
}: SelectFieldProps<T>) {
  return (
    <Field label={label} hint={hint}>
      {({ id, describedBy }) => (
        <select
          id={id}
          value={value}
          disabled={disabled}
          aria-describedby={describedBy}
          onChange={(event) => onChange(event.target.value as T)}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      )}
    </Field>
  );
}

interface ColorFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
}

export function ColorField({ label, value, onChange, hint }: ColorFieldProps) {
  return (
    <Field label={label} hint={hint} value={value.toUpperCase()}>
      {({ id, describedBy }) => (
        <input
          id={id}
          type="color"
          value={value}
          aria-describedby={describedBy}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </Field>
  );
}

interface CheckboxProps {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}

export function Checkbox({ label, checked, onChange, disabled }: CheckboxProps) {
  return (
    <label className="checkbox">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
}

// ---------------------------------------------------------------------------
// 状態表示
// ---------------------------------------------------------------------------

export function Alert({
  kind,
  title,
  children,
}: {
  kind: 'error' | 'warning' | 'info';
  title?: string;
  children: ReactNode;
}) {
  return (
    <div className={`alert alert-${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      {title && <strong>{title}</strong>}
      {children}
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty-state">
      <strong>{title}</strong>
      {children}
    </div>
  );
}

export function ProgressBar({ ratio, label }: { ratio: number; label: string }) {
  const percent = Math.round(Math.min(1, Math.max(0, ratio)) * 100);
  return (
    <div>
      <div
        className="progress"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-label={label}
      >
        <div style={{ width: `${percent}%` }} />
      </div>
      <p className="field-hint" aria-live="polite">
        {label}（{percent}%）
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// トースト
// ---------------------------------------------------------------------------

export interface ToastMessage {
  id: number;
  kind: 'error' | 'success' | 'info';
  text: string;
  hint?: string;
}

interface ToastApi {
  push: (kind: ToastMessage['kind'], text: string, hint?: string) => void;
  /** Error を受け取り、独自エラー型の hint を拾って表示する */
  pushError: (error: unknown, fallback?: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [messages, setMessages] = useState<ToastMessage[]>([]);
  const nextId = useRef(1);

  const push = useCallback((kind: ToastMessage['kind'], text: string, hint?: string) => {
    const id = nextId.current++;
    setMessages((prev) => [...prev.slice(-4), { id, kind, text, hint }]);
    const timeout = kind === 'error' ? 12_000 : 5_000;
    setTimeout(() => setMessages((prev) => prev.filter((m) => m.id !== id)), timeout);
  }, []);

  const pushError = useCallback(
    (error: unknown, fallback = '処理に失敗しました。') => {
      if (error instanceof Error && error.name === 'AbortError') return;
      const text = error instanceof Error ? error.message : fallback;
      const hint =
        error && typeof error === 'object' && 'hint' in error && typeof error.hint === 'string'
          ? error.hint
          : undefined;
      push('error', text, hint);
    },
    [push],
  );

  const api = useMemo(() => ({ push, pushError }), [push, pushError]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toast-region" role="region" aria-label="通知">
        {messages.map((message) => (
          <div
            key={message.id}
            className={`toast toast-${message.kind}`}
            role={message.kind === 'error' ? 'alert' : 'status'}
          >
            {message.text}
            {message.hint && <span className="toast-hint">{message.hint}</span>}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast must be used within ToastProvider');
  return context;
}

// ---------------------------------------------------------------------------
// エラーバウンダリ
// ---------------------------------------------------------------------------

interface BoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, BoundaryState> {
  state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: unknown): void {
    console.error('UI で予期しないエラーが発生しました', error, info);
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="panel" role="alert" style={{ margin: 24 }}>
          <h2>予期しないエラーが発生しました</h2>
          <p className="panel-desc">
            保存済みのプロジェクトは残っています。ページを再読み込みしてやり直してください。
          </p>
          <pre
            style={{
              whiteSpace: 'pre-wrap',
              fontSize: 12,
              color: 'var(--text-muted)',
              maxHeight: 200,
              overflow: 'auto',
            }}
          >
            {this.state.error.message}
          </pre>
          <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
            再読み込み
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00.0';
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return '—';
  if (bytes >= 1 << 30) return `${(bytes / (1 << 30)).toFixed(1)} GB`;
  if (bytes >= 1 << 20) return `${(bytes / (1 << 20)).toFixed(1)} MB`;
  if (bytes >= 1 << 10) return `${(bytes / (1 << 10)).toFixed(0)} KB`;
  return `${bytes} B`;
}
