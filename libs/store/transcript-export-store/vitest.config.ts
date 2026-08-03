import { defineConfig, mergeConfig } from 'vitest/config';

import sharedConfig from '../../../vitest.shared.js';

export default mergeConfig(
  sharedConfig,
  defineConfig({
    test: {
      include: ['./tests/**/*.test.ts'],
      projects: [
        {
          extends: true,
          test: {
            name: 'unit',
            // jsdom, not node: the service reads `globalThis.Translator` and
            // the tests install a fake one, which is only a faithful stand-in
            // inside a browser-shaped global.
            environment: 'jsdom',
          },
        },
      ],
    },
  }),
);
