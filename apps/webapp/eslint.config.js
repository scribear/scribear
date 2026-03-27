import eslintReact from '@eslint-react/eslint-plugin';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import { defineConfig } from 'eslint/config';

import baseConfig from '../../eslint.config.js';

export default defineConfig([
  ...baseConfig,
  {
    // Only apply React rules to React component files
    files: ['**/*.{ts,mts,cts,tsx}'],
    extends: [
      /**
       * @see https://react.dev/reference/rules/rules-of-hooks
       * @see https://react.dev/learn/react-compiler/installation#eslint-integration
       * Allows ESLint to enforce the "Rules of Hooks"
       */
      reactHooks.configs.flat.recommended,

      /**
       * @see https://github.com/ArnaudBarre/eslint-plugin-react-refresh
       * Allows ESLint to ensure your components can be safely updated with Fast Refresh
       */
      reactRefresh.configs.vite,

      /**
       * @see https://eslint-react.xyz/docs/presets#typescript-specialized
       * Allows ESLint to enforce rules that are recommended general purpose React + React DOM projects
       */
      eslintReact.configs['recommended-type-checked'],
    ],
  },
]);
