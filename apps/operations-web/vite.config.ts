import { defineConfig } from 'vite';

export default defineConfig({
  envDir: '../../',
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
  server: {
    host: '127.0.0.1',
    port: 4173,
    proxy: {
      '/api': 'http://127.0.0.1:3000',
      '/health': 'http://127.0.0.1:3000',
    },
  },
});
