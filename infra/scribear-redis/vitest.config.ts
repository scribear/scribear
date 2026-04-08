import { defineConfig, mergeConfig } from 'vitest/config';

import sharedConfig from '../../vitest.shared.ts';

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
            exclude: ['tests/integration/**'],
          },
        },
        {
          extends: true,
          test: {
            name: 'integration',
            environment: 'node',
            exclude: ['tests/unit/**'],
            fileParallelism: false,
            globalSetup: ['./tests/integration/global-setup.ts'],
          },
        },
      ],
    },
  }),
);
