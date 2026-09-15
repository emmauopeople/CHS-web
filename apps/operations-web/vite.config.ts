import { defineConfig } from 'vite';

export default defineConfig({
  envDir: '../../',
  plugins: [{
    name: 'local-development-csp',
    apply: 'serve',
    transformIndexHtml(html) {
      // Vite injects styles during development. The built HTML retains the
      // original policy: neither inline styles nor HTTP identity endpoints.
      return html
        .replace("style-src 'self';", "style-src 'self' 'unsafe-inline';")
        .replace("connect-src 'self' https:;", "connect-src 'self' https: http://127.0.0.1:18080 ws://127.0.0.1:4173 ws://localhost:4173;");
    },
  }],
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
  server: {
    host: '127.0.0.1',
    port: 4173,
    strictPort: true,
    proxy: {
      '/api': 'http://127.0.0.1:3000',
      '/health': 'http://127.0.0.1:3000',
    },
  },
});
