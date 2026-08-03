import { defineConfig, mergeConfig } from 'vitest/config';

import sharedConfig from '../../vitest.shared.js';

export default mergeConfig(
  sharedConfig,
  defineConfig({
    test: {
      include: ['./tests/**/*.test.{ts,tsx}'],
      projects: [
        {
          extends: true,
          test: {
            name: 'unit',
            environment: 'jsdom',
          },
        },
      ],
    },
  }),
);
