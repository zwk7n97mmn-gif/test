import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// GitHub Pages のようなサブパス配信に対応するため、ベースパスを環境変数で切り替える。
// 例) BASE_PATH=/my-repo/ npm run build
const base = process.env.BASE_PATH ?? '/';

export default defineConfig({
  base,
  plugins: [react()],
  server: {
    headers: {
      // WebCodecs / SharedArrayBuffer を使う将来拡張のために crossOriginIsolated を有効化しておく。
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
    },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      output: {
        // three.js と React は更新頻度が低いので別チャンクにして、
        // アプリ更新時の再ダウンロード量を減らす。
        manualChunks: {
          three: ['three'],
          react: ['react', 'react-dom'],
        },
      },
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
