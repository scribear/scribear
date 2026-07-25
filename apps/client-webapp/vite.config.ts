/// <reference types="vitest" />
/// <reference types="vite/client" />
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const VENDOR_PACKAGES = [
  'react',
  'react-dom',
  '@mui/material',
  '@mui/icons-material',
  '@emotion/react',
  '@emotion/styled',
  '@base-ui/react',
  '@reduxjs/toolkit',
  'react-redux',
  'redux-remember',
];

// https://vite.dev/config/
export default defineConfig({
  base: './',
  plugins: [react()],
  resolve: {
    conditions: ['development'],
    tsconfigPaths: true,
  },
  build: {
    // Vite 8 / rolldown no longer accepts object-form `manualChunks`; use the
    // `codeSplitting.groups` API instead (see https://rolldown.rs/in-depth/manual-code-splitting).
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: 'vendor',
              test: (id: string) =>
                VENDOR_PACKAGES.some((pkg) =>
                  id.replaceAll('\\', '/').includes(`/node_modules/${pkg}/`),
                ),
            },
          ],
        },
      },
    },
  },
  server: {
    port: 3001,
    proxy: {
      '/api/session-manager': 'http://localhost:8001',
      '/api/node-server': { target: 'http://localhost:8002', ws: true },
    },
  },
  preview: {
    port: 3002,
  },
});
