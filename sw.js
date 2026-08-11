/**
 * Service Worker。
 *
 * 目的は「ホーム画面から起動できること」と「電波が無くても開けること」。
 * 動画処理はすべて端末内で完結するため、アプリの殻さえキャッシュできれば
 * 機内モードでも編集を続けられる。
 *
 * 方針:
 *   - アプリシェル（HTML/CSS/JS/アイコン）は install 時に先読み
 *   - 取得時はネットワーク優先＋キャッシュ更新。失敗したらキャッシュへ退避
 *   - 版が上がったら古いキャッシュを消す
 */

const VERSION = 'kirinuki-v2';
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './src/styles.css',
  './src/app.js',
  './assets/icon-192.png',
  './assets/icon-512.png',
  './assets/icon-maskable-512.png',
  './assets/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(VERSION);
      // 1 つでも失敗するとインストール全体が落ちるため個別に扱う
      await Promise.allSettled(SHELL.map((url) => cache.add(url)));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((key) => key !== VERSION).map((key) => caches.delete(key)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // 外部（STT など）は素通し

  event.respondWith(
    (async () => {
      try {
        const response = await fetch(request);
        if (response && response.ok) {
          const cache = await caches.open(VERSION);
          cache.put(request, response.clone());
        }
        return response;
      } catch (error) {
        const cached = await caches.match(request, { ignoreSearch: true });
        if (cached) return cached;
        // 画面遷移はアプリシェルへ退避する
        if (request.mode === 'navigate') {
          const shell = await caches.match('./index.html');
          if (shell) return shell;
        }
        throw error;
      }
    })(),
  );
});
