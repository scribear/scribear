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
        //
        // B1: dev-only swagger plugin — two register calls, no production impact.
        // B4: type-only module (AppDependencies interface + declare module) — no
        //     runtime code beyond a side-effect import.
        // B5: trivial transport/wiring — one-line registrations and {status:'ok'}
        //     handlers exercised by integration. Unit tests would be pure
        //     coverage-chasing; see PLAN-MORE-TESTCOVERAGE.md §B5.
        //
        // Additional low-risk files: thin transport controllers and routers
        // that delegate to unit-tested services. Integration-covered by design.
        exclude: [
          'src/index.ts',
          '**/*.py',
          '**/*.json',
          'src/server/plugins/swagger.ts',
          'src/server/plugins/websocket.ts',
          '**/app-dependencies.ts',
          'src/server/features/probes/liveness.controller.ts',
          'src/server/features/probes/probes.router.ts',
          'src/server/features/status/status.router.ts',
          'src/server/features/status/status.controller.ts',
          'src/server/features/transcription-stream/transcription-stream.router.ts',
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
