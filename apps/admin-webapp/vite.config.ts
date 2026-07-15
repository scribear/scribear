/// <reference types="vitest" />
/// <reference types="vite/client" />
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import viteTsconfigPaths from 'vite-tsconfig-paths';

// https://vite.dev/config/
export default defineConfig({
  // Served under /admin/ by nginx; keeping the base aligned lets the router use
  // `/admin` as its basename in both dev and production.
  base: '/admin/',
  plugins: [react(), viteTsconfigPaths()],
  resolve: {
    conditions: ['development'],
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: [
            'react',
            'react-dom',
            '@mui/material',
            '@mui/icons-material',
            '@emotion/react',
            '@emotion/styled',
            'react-router-dom',
          ],
        },
      },
    },
  },
  server: {
    port: 3003,
    proxy: {
      '/api/admin': 'http://localhost:8003',
    },
  },
  preview: {
    port: 3004,
  },
});
