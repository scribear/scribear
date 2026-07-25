/// <reference types="vitest" />
/// <reference types="vite/client" />
import react from '@vitejs/plugin-react';
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type PluginOption } from 'vite';

const VENDOR_PACKAGES = [
  'react',
  'react-dom',
  '@mui/material',
  '@mui/icons-material',
  '@emotion/react',
  '@emotion/styled',
  'react-router-dom',
];

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Copies the standalone audio meter page into the build output so nginx serves
 * a real file at `/admin/audio-meter.html` (the `try_files` fallback in the
 * admin-webapp Dockerfile serves a static file before falling back to the SPA).
 *
 * The page lives in the shared `libs/audio-meter-page/` directory so the
 * monitoring sidecar and admin-webapp serve byte-identical copies. Deliberately
 * not `vite-plugin-static-copy` (a new dependency for one file) and not
 * `publicDir` pointing outside the package (which would silently ship anything
 * else that lands in that directory later).
 */
function copyAudioMeterPage(): PluginOption {
  const src = resolve(__dirname, '../../libs/audio-meter-page/audio-meter.html');
  return {
    name: 'copy-audio-meter-page',
    closeBundle() {
      const dest = resolve(__dirname, 'dist/audio-meter.html');
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(src, dest);
    },
  };
}

// https://vite.dev/config/
export default defineConfig({
  // Served under /admin/ by nginx; keeping the base aligned lets the router use
  // `/admin` as its basename in both dev and production.
  base: '/admin/',
  // `vite-tsconfig-paths` was dropped upstream in favour of Vite 8's native
  // `resolve.tsconfigPaths` (below); only the audio-meter copy plugin is local.
  plugins: [react(), copyAudioMeterPage()],
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
    port: 3003,
    proxy: {
      '/api/admin': 'http://localhost:8003',
    },
  },
  preview: {
    port: 3004,
  },
});
