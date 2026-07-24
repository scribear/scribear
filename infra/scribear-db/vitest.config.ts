import { defineConfig, mergeConfig } from 'vitest/config';

import sharedConfig from '../../vitest.shared.js';

export default mergeConfig(
  sharedConfig,
  defineConfig({
    test: {
      coverage: {
        // Script entrypoints (`migrate`, `generate:types`) and the generated
        // kysely types. Nothing unit-testable: the migrator itself is exercised
        // for real by every app's integration suite, which migrates a container.
        exclude: [
          'src/scripts/migrate.ts',
          'src/scripts/generate-types.ts',
          'src/database.types.ts',
        ],
      },
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
