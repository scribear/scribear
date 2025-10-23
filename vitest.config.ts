import { defineConfig } from 'vitest/config';

/**
 * @see https://vitest.dev/guide/projects.html#defining-projects
 * @see https://vitest.dev/config/
 * Defines the root Vitest configuration.
 * It is primarily used to discover and run test files across multiple sub-projects (apps and libs) within the repository.
 * It doesn't contain test-specific setup but rather high-level project management.
 */
export default defineConfig({
  test: {
    // Configure Vitest to treat each folder containing a vitest.config.ts file a separate project
    projects: ['./{apps,libs}/*/vitest.config.ts'],
  },
});
