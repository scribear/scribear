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
        //
        // Additional low-risk files: thin transport controllers, routers, and
        // data-access repositories that are integration-covered by design
        // (real Postgres testcontainer). Excluding from coverage so the unit
        // report stops flagging them as ❌; see PLAN-MORE-TESTCOVERAGE.md §B5/§B6.
        exclude: [
          'src/index.ts',
          'src/migrate.ts',
          'src/server/plugins/swagger.ts',
          '**/app-dependencies.ts',
          'src/server/features/database/database.router.ts',
          'src/server/features/database/database.controller.ts',
          'src/server/features/probes/liveness.controller.ts',
          'src/server/features/probes/probes.router.ts',
          'src/server/features/demo-room/demo-room-seeder.ts',
          'src/server/features/demo-room/demo-room.router.ts',
          'src/server/features/device-management/device-management.router.ts',
          'src/server/features/device-management/device-management.repository.ts',
          'src/server/features/room-management/room-management.router.ts',
          'src/server/features/room-management/room-management.repository.ts',
          'src/server/features/schedule-management/schedule-management.router.ts',
          'src/server/features/session-auth/session-auth.router.ts',
          'src/server/features/session-auth/session-auth.repository.ts',
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
