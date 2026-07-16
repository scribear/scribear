import { defineConfig, mergeConfig } from 'vitest/config';

import sharedConfig from '../../vitest.shared.js';

export default mergeConfig(
  sharedConfig,
  defineConfig({
    test: {
      coverage: {
        // Process entrypoint: bootstraps and starts the server. It has no unit-
        // testable logic and is exercised by the integration suite, so exclude
        // it rather than report it as uncovered.
        exclude: ['src/index.ts'],
      },
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
