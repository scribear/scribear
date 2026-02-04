/// <reference types="vitest" />
/// <reference types="vite/client" />
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import viteTsconfigPaths from 'vite-tsconfig-paths';

// https://vite.dev/config/
export default defineConfig({
  base: './',
  plugins: [react(), viteTsconfigPaths()],
  server: {
    port: 3000,
  },
  preview: {
    port: 3000,
  },
});
