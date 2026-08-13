import { useEffect, useState } from 'react';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const DISMISS_KEY = 'motion-muse:install-dismissed';

/**
 * ホーム画面への追加を促すバナー。
 *
 * Android / デスクトップ Chrome では beforeinstallprompt を使って直接インストールでき、
 * iOS Safari はその API が無いため手順を案内する。
 */
export function InstallBanner() {
  const [promptEvent, setPromptEvent] = useState<BeforeInstallPromptEvent | null>(null);
  const [showIosHint, setShowIosHint] = useState(false);
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(DISMISS_KEY) === '1';
    } catch {
      return false;
    }
  });

  useEffect(() => {
    if (dismissed) return;
    // 既にスタンドアロン起動しているなら案内しない
    const standalone =
      window.matchMedia?.('(display-mode: standalone)').matches ||
      (window.navigator as { standalone?: boolean }).standalone === true;
    if (standalone) return;

    const onPrompt = (event: Event) => {
      event.preventDefault();
      setPromptEvent(event as BeforeInstallPromptEvent);
    };
    window.addEventListener('beforeinstallprompt', onPrompt);

    const ua = navigator.userAgent;
    const isIos = /iPad|iPhone|iPod/.test(ua) && !/CriOS|FxiOS/.test(ua);
    if (isIos) setShowIosHint(true);

    return () => window.removeEventListener('beforeinstallprompt', onPrompt);
  }, [dismissed]);

  if (dismissed || (!promptEvent && !showIosHint)) return null;

  const close = () => {
    setDismissed(true);
    try {
      localStorage.setItem(DISMISS_KEY, '1');
    } catch {
      /* ストレージが使えない環境では記憶しない */
    }
  };

  return (
    <div className="install-banner" role="region" aria-label="ホーム画面への追加">
      <span aria-hidden="true" style={{ fontSize: 20 }}>
        📲
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        {promptEvent ? (
          <>アプリとしてインストールすると、全画面・オフラインで使えます。</>
        ) : (
          <>
            共有メニュー → <strong>ホーム画面に追加</strong> で、アプリとして全画面で使えます。
          </>
        )}
      </div>
      {promptEvent && (
        <button
          type="button"
          className="btn btn-primary btn-small"
          onClick={() => {
            void promptEvent.prompt().then(() => {
              setPromptEvent(null);
              close();
            });
          }}
        >
          追加
        </button>
      )}
      <button type="button" className="btn btn-small" onClick={close} aria-label="この案内を閉じる">
        ✕
      </button>
    </div>
  );
}
