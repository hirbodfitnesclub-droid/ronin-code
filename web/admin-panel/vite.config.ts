import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev only: the standalone admin app listens on 7444 and serves this
// build from web/admin-panel/dist in production (same origin).
const ADMIN = 'http://127.0.0.1:7444';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    proxy: {
      '/admin-api': { target: ADMIN, changeOrigin: true },
    },
  },
  preview: {
    port: 5174,
    proxy: {
      '/admin-api': { target: ADMIN, changeOrigin: true },
    },
  },
});
