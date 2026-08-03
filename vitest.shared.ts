import { defineConfig } from 'vitest/config';

/**
 * @see https://vitest.dev/config/
 * Defines a shared vitest configuration for all packages
 */
export default defineConfig({
  resolve: {
    // Match the `development` condition used in package.json `exports`/`imports`
    // so `#src/*` resolves to source during tests, not built dist.
    conditions: ['development'],
    // Vite 8 resolves tsconfig `paths` natively; replaces vite-tsconfig-paths.
    tsconfigPaths: true,
  },
  test: {
    include: ['./tests/**/*.test.ts'],
    coverage: {
      enabled: true,
      include: ['src'],
      provider: 'istanbul', // or 'v8'
      // Text to enable quick summary in terminal
      // HTML for interactive view, with line by line breakdown
      // cobertura for CI/CD actions
      reporter: ['text', 'html', 'cobertura'],
    },
  },
});
