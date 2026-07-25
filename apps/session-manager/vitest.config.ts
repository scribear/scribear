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
        // B3: migrate.ts is a separate one-shot CLI process (compose db-migrate)
        //     — straight-line control flow with process.exit, verified by deployment.
        // B1: dev-only swagger plugin — two register calls, no production impact.
        // B4: type-only module (AppDependencies interface + declare module) — no
        //     runtime code beyond a side-effect import.
        // B5: trivial transport/wiring — single fastify.route call exercised by
        //     integration. See PLAN-MORE-TESTCOVERAGE.md §B5.
        exclude: [
          'src/index.ts',
          'src/migrate.ts',
          'src/server/plugins/swagger.ts',
          '**/app-dependencies.ts',
          'src/server/features/database/database.router.ts',
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
            globalSetup: ['./tests/integration/global-setup.ts'],
          },
        },
      ],
    },
  }),
);
