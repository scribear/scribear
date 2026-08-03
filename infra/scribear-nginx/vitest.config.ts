import { defineConfig, mergeConfig } from 'vitest/config';

import sharedConfig from '../../vitest.shared.js';

export default mergeConfig(
  sharedConfig,
  defineConfig({
    test: {
      projects: [
        {
          extends: true,
          test: {
            name: 'unit',
            environment: 'node',
          },
        },
      ],
    },
  }),
);
