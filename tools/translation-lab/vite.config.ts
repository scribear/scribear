import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const labRoot = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: labRoot,
  resolve: {
    conditions: ['development'],
    tsconfigPaths: true,
  },
  build: {
    outDir: resolve(labRoot, 'dist'),
    emptyOutDir: true,
  },
  server: {
    host: '127.0.0.1',
    port: 4173,
    strictPort: true,
    headers: {
      'Permissions-Policy':
        'microphone=(self), on-device-speech-recognition=(self)',
    },
    proxy: {
      '/mozilla-models': {
        target: 'https://storage.googleapis.com',
        changeOrigin: true,
        secure: true,
        rewrite: (path) =>
          path.replace(
            /^\/mozilla-models/,
            '/moz-fx-translations-data--303e-prod-translations-data',
          ),
      },
    },
  },
  preview: {
    host: '127.0.0.1',
    port: 4173,
    strictPort: true,
  },
});
