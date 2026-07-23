/// <reference types="vitest" />
/// <reference types="vite/client" />
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import viteTsconfigPaths from 'vite-tsconfig-paths';

const VENDOR_PACKAGES = [
  'react',
  'react-dom',
  '@mui/material',
  '@mui/icons-material',
  '@emotion/react',
  '@emotion/styled',
  'react-router-dom',
];

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
    port: 3003,
    proxy: {
      '/api/admin': 'http://localhost:8003',
    },
  },
  preview: {
    port: 3004,
  },
});
