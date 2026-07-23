import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';

// Initialize Sentry for error monitoring in production
import './sentry';

const container = document.getElementById('root');
if (!container) {
  throw new Error('Root element not found');
}
const root = createRoot(container);
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
