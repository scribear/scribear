import { defineConfig, mergeConfig } from 'vitest/config';

import sharedConfig from '../../vitest.shared.js';

export default mergeConfig(
  sharedConfig,
  defineConfig({
    test: {
      coverage: {
        exclude: [
          // Process entrypoint: bootstraps and starts the server. No
          // unit-testable logic, and the integration suite boots it for real.
          'src/index.ts',
          // Build-time CLI wrapper around `buildLongformWav`, which is itself
          // covered. It exists to be run by the Dockerfile, not by a test.
          'src/scripts/build-longform-clip.ts',
        ],
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
          },
        },
      ],
    },
  }),
);
