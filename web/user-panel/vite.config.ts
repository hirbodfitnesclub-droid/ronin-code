import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The user API (127.0.0.1:7443) sends NO CORS headers, so in dev/preview the
// panel must be same-origin with it: Vite proxies /api and /hooks to the API.
// In production the panel is served same-origin by the API host itself.
const API = 'http://127.0.0.1:7443';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    proxy: {
      '/api': { target: API, changeOrigin: true },
      '/hooks': { target: API, changeOrigin: true },
    },
  },
  preview: {
    port: 5174,
    proxy: {
      '/api': { target: API, changeOrigin: true },
      '/hooks': { target: API, changeOrigin: true },
    },
  },
});
