import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const HOST = 'http://127.0.0.1:7331';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: HOST, changeOrigin: true },
      '/health': { target: HOST, changeOrigin: true },
      '/preview': { target: HOST, changeOrigin: true },
      '/ronin-config.js': { target: HOST, changeOrigin: true },
    },
  },
  preview: {
    port: 5173,
    proxy: {
      '/api': { target: HOST, changeOrigin: true },
      '/health': { target: HOST, changeOrigin: true },
      '/preview': { target: HOST, changeOrigin: true },
      '/ronin-config.js': { target: HOST, changeOrigin: true },
    },
  },
});
