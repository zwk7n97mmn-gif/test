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
