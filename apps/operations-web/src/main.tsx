import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import App from './App';
import { loadConfig } from './config';
import './styles.css';

function ConfigurationError() {
  return (
    <main className="sign-in-page">
      <section className="sign-in-card">
        <p className="eyebrow">Configuration required</p>
        <h1>Operations portal unavailable</h1>
        <p>The operations web configuration is incomplete. Contact the system administrator.</p>
      </section>
    </main>
  );
}

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Application root is missing');
const root = createRoot(rootElement);

try {
  const config = loadConfig();
  root.render(<StrictMode><App config={config} /></StrictMode>);
} catch {
  root.render(<StrictMode><ConfigurationError /></StrictMode>);
}
