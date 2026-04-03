/// <reference types="vitest" />
/// <reference types="vite/client" />
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import viteTsconfigPaths from 'vite-tsconfig-paths';

// https://vite.dev/config/
export default defineConfig({
  base: './',
  plugins: [react(), viteTsconfigPaths()],
  resolve: {
    conditions: ['development'],
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor-react': ['react', 'react-dom'],
          'vendor-mui': [
            '@mui/material',
            '@mui/icons-material',
            '@emotion/react',
            '@emotion/styled',
          ],
          'vendor-redux': ['@reduxjs/toolkit', 'react-redux', 'redux-remember'],
        },
      },
    },
  },
  server: {
    port: 3000,
    proxy: {
      '/api/session-manager': 'http://localhost:8001',
      '/api/node-server': { target: 'http://localhost:8002', ws: true },
    },
  },
  preview: {
    port: 3000,
  },
});
