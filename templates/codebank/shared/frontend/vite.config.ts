import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// The frontend calls /api/...; Vite forwards those requests to the backend, so the browser's
// Network tab shows every API call on the same address as the page. Host and allowed hosts come from
// the environment, so the same app runs on a learner's computer and behind a cloud agent's URL.
export default defineConfig({
  plugins: [react()],
  server: {
    host: process.env.FRONTEND_HOST ?? '127.0.0.1',
    port: 5173,
    allowedHosts: process.env.FRONTEND_ALLOWED_HOSTS ? process.env.FRONTEND_ALLOWED_HOSTS.split(',') : undefined,
    proxy: {
      '/api': process.env.BACKEND_URL ?? 'http://127.0.0.1:8000',
    },
  },
  test: {
    environment: 'jsdom',
  },
});
