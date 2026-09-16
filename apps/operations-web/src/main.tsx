import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import App from './App';
import { loadConfig, LocalPortalAddressError } from './config';
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
} catch (error) {
  root.render(error instanceof LocalPortalAddressError ? (
    <main className="sign-in-page">
      <section className="sign-in-card">
        <h1>Open the local operations portal</h1>
        <p>Local sign-in requires this registered address:</p>
        <a href={error.portalUrl}>{error.portalUrl}</a>
      </section>
    </main>
  ) : <StrictMode><ConfigurationError /></StrictMode>);
}
