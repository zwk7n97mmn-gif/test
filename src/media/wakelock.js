/**
 * 画面消灯の抑止（Screen Wake Lock API）。
 *
 * 書き出しや解析の最中にスマートフォンの画面が消えると、
 * 処理が絞られて極端に遅くなる（従来の実時間録画では成果物が壊れる）。
 * 非対応環境では何もしないが、UI 側で注意書きを出せるよう supported を公開する。
 */

export function isWakeLockSupported() {
  return typeof navigator !== 'undefined' && 'wakeLock' in navigator;
}

export function createWakeLock() {
  let sentinel = null;
  let wanted = false;

  const acquire = async () => {
    if (!wanted || !isWakeLockSupported() || sentinel) return;
    try {
      sentinel = await navigator.wakeLock.request('screen');
      sentinel.addEventListener('release', () => {
        sentinel = null;
      });
    } catch {
      sentinel = null; // 電池残量が少ない等で拒否されることがある
    }
  };

  // タブが再表示されたら取り直す（バックグラウンドで自動解除されるため）
  const onVisibility = () => {
    if (document.visibilityState === 'visible') acquire();
  };
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibility);
  }

  return {
    supported: isWakeLockSupported(),
    get active() {
      return Boolean(sentinel);
    },
    async request() {
      wanted = true;
      await acquire();
      return Boolean(sentinel);
    },
    async release() {
      wanted = false;
      if (!sentinel) return;
      try {
        await sentinel.release();
      } catch {
        /* 既に解除済み */
      }
      sentinel = null;
    },
    dispose() {
      wanted = false;
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
      if (sentinel) sentinel.release().catch(() => {});
      sentinel = null;
    },
  };
}
