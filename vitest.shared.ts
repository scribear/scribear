import viteTsconfigPaths from 'vite-tsconfig-paths';
import { defineConfig } from 'vitest/config';

/**
 * @see https://vitest.dev/config/
 * Defines a shared vitest configuration for all packages
 */
export default defineConfig({
  plugins: [viteTsconfigPaths()],
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
