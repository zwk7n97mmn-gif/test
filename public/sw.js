/**
 * Motion Muse の Service Worker。
 *
 * 目的は「一度開けば、電波が無いところでも同じように使える」こと。
 * ビルドごとにファイル名が変わるハッシュ付きアセットに対応するため、
 * 事前列挙ではなくリクエストの種類ごとに戦略を切り替えている。
 *
 *  - ナビゲーション（HTML） : ネットワーク優先 → 失敗時はキャッシュ
 *  - ハッシュ付きアセット   : キャッシュ優先（内容が変わらないため）
 *  - モデル / WASM         : キャッシュ優先（大きいので再取得を避ける）
 *  - それ以外の同一オリジン : stale-while-revalidate
 */
const VERSION = 'v2';
const SHELL_CACHE = `motion-muse-shell-${VERSION}`;
const ASSET_CACHE = `motion-muse-assets-${VERSION}`;
const HEAVY_CACHE = `motion-muse-heavy-${VERSION}`;

const SHELL_URLS = ['./', './index.html', './manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // 1つでも失敗するとインストール全体が落ちるため個別に握りつぶす
      await Promise.all(
        SHELL_URLS.map((url) => cache.add(new Request(url, { cache: 'reload' })).catch(() => undefined)),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key.startsWith('motion-muse-') && !key.endsWith(VERSION))
          .map((key) => caches.delete(key)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});

const isHeavyAsset = (pathname) =>
  pathname.includes('/models/') || pathname.includes('/mediapipe/') || pathname.endsWith('.task');

// サブパス配信（/repo/ 以下など）でも一致するよう includes で判定する
const isImmutableAsset = (pathname) => pathname.includes('/assets/') || pathname.includes('/icons/');

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok && response.status === 200) {
    cache.put(request, response.clone()).catch(() => undefined);
  }
  return response;
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then((response) => {
      if (response.ok && response.status === 200) {
        cache.put(request, response.clone()).catch(() => undefined);
      }
      return response;
    })
    .catch(() => undefined);
  return cached ?? (await network) ?? Response.error();
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // HTML はネットワーク優先（更新を取りこぼさないため）
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const response = await fetch(request);
          const cache = await caches.open(SHELL_CACHE);
          cache.put('./index.html', response.clone()).catch(() => undefined);
          return response;
        } catch {
          const cache = await caches.open(SHELL_CACHE);
          return (
            (await cache.match('./index.html')) ??
            (await cache.match('./')) ??
            new Response('オフラインです。一度オンラインで開いてからご利用ください。', {
              status: 503,
              headers: { 'Content-Type': 'text/plain; charset=utf-8' },
            })
          );
        }
      })(),
    );
    return;
  }

  if (isHeavyAsset(url.pathname)) {
    event.respondWith(cacheFirst(request, HEAVY_CACHE));
    return;
  }

  if (isImmutableAsset(url.pathname)) {
    event.respondWith(cacheFirst(request, ASSET_CACHE));
    return;
  }

  event.respondWith(staleWhileRevalidate(request, ASSET_CACHE));
});
