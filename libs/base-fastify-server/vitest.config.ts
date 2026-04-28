import { defineProject, mergeConfig } from 'vitest/config';

import sharedConfig from '../../vitest.shared.js';

export default mergeConfig(
  sharedConfig,
  defineProject({
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
            fileParallelism: false,
            exclude: ['tests/unit/**'],
          },
        },
      ],
    },
  }),
);
