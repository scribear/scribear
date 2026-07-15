import { defineProject, mergeConfig } from 'vitest/config';

import sharedConfig from '../../vitest.shared.js';

export default mergeConfig(
  sharedConfig,
  defineProject({
    test: {
      coverage: {
        // Bootstrap/wiring with no unit-testable logic: the barrel export, the
        // server factory, and the logger factory. These are exercised by the
        // integration suite, so exclude them rather than report them uncovered.
        exclude: [
          'src/index.ts',
          'src/server/create-base-server.ts',
          'src/server/create-logger.ts',
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
            fileParallelism: false,
            exclude: ['tests/unit/**'],
          },
        },
      ],
    },
  }),
);
