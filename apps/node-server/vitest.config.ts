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
        //
        // The demo-room fixture generator is a standalone Python dev tool that
        // lives beside the fixture it produces; it is not application source
        // and must not be fed to the JS coverage instrumenter. The same goes
        // for the JSON fixtures it emits — data, not code.
        exclude: ['src/index.ts', '**/*.py', '**/*.json'],
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
