import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { WorkspaceProvider } from './state/workspace';
import { ErrorBoundary, ToastProvider } from './ui/primitives';
import './styles.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('#root が見つかりません');
}

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary>
      <ToastProvider>
        <WorkspaceProvider>
          <App />
        </WorkspaceProvider>
      </ToastProvider>
    </ErrorBoundary>
  </StrictMode>,
);

// オフラインで使えるようにするための Service Worker。
// 開発中は登録しない（HMR と競合するため）。
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch((err) => {
      // 登録に失敗してもアプリ自体は動くので、警告に留める
      console.warn('Service Worker を登録できませんでした', err);
    });
  });
}
