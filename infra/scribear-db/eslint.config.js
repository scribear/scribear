import { defineConfig } from 'eslint/config';

import baseConfig from '../../eslint.config.js';

export default defineConfig([
  ...baseConfig,
  {
    // Disable linting for auto-generated kysely types
    files: ['src/database.types.ts'],
    rules: {
      '@typescript-eslint/consistent-type-definitions': 'off',
    },
  },
]);
