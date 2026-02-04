import eslintReact from '@eslint-react/eslint-plugin';
import js from '@eslint/js';
import eslintConfigPrettierFlat from 'eslint-config-prettier/flat';
import checkFile from 'eslint-plugin-check-file';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * @see https://typescript-eslint.io/getting-started/#step-2-configuration
 * @see https://typescript-eslint.io/users/configs
 * @see https://eslint.org/docs/latest/use/configure/
 *
 * This config object configures ESLint
 * ESLint is a code linter that analyzes code before it is run
 * This helps
 * - Catch potential errors
 * - Mantain code quality
 */
export default defineConfig([
  {
    // Only lint Typescript files
    files: ['**/*.{ts,mts,cts,tsx}'],
    plugins: {
      'check-file': checkFile,
    },
    extends: [
      /**
       * @see https://eslint.org/docs/latest/use/configure/configuration-files#using-predefined-configurations
       * Uses recommended ESLint rules for Javscript provided by ESLint
       */
      js.configs.recommended,

      /**
       * @see https://typescript-eslint.io/users/configs#strict-type-checked
       * Uses strict ESLint rules to prevent bugs provided by typescript-eslint
       */
      tseslint.configs.strictTypeChecked,

      /**
       * @see https://typescript-eslint.io/users/configs#stylistic-type-checked
       * Uses ESLint rules for Typescript best practices provided by typescript-eslint
       */
      tseslint.configs.stylisticTypeChecked,

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

      /**
       * @see https://github.com/prettier/eslint-config-prettier
       * Disables ESLint rules that conflict with Prettier
       */
      eslintConfigPrettierFlat,
    ],
    languageOptions: {
      /**
       * @see https://typescript-eslint.io/getting-started/typed-linting
       * Typescript parsing is required for type checked ESLint rules
       */
      parserOptions: {
        projectService: true,
      },
      // Match tsconfig.json version target
      ecmaVersion: 2024,
      // Configures global variables ESLint should be aware of
      globals: {
        // Include global variables provided by browsers
        ...globals.browser,
        // Include global variables provided by node
        ...globals.node,
      },
    },
    rules: {
      /**
       * @see https://eslint.org/docs/latest/rules/no-restricted-imports
       * @see https://mui.com/material-ui/guides/minimizing-bundle-size/#enforce-best-practices-with-eslint
       * Restrict use of MUI barrel imports for better dev startup/rebuild performance
       */
      'no-restricted-imports': [
        'error',
        {
          patterns: [{ regex: '^@mui/[^/]+$' }],
        },
      ],
      /**
       * @see https://redux.js.org/usage/usage-with-typescript#use-typed-hooks-in-components
       * Restrict use of useSelector and useDispatch in favor of useAppDispatch and useAppSelector
       */
      '@typescript-eslint/no-restricted-imports': [
        'warn',
        {
          name: 'react-redux',
          importNames: ['useSelector', 'useDispatch'],
          message:
            'Use typed hooks `useAppDispatch` and `useAppSelector` instead.',
        },
      ],
      /**
       * @see https://github.com/dukeluo/eslint-plugin-check-file
       * A collection of rules for consistent folder and file naming
       */
      'check-file/filename-naming-convention': [
        'error',
        {
          '**/*.{ts,mts,cts,tsx}': 'KEBAB_CASE',
        },
        {
          ignoreMiddleExtensions: true,
        },
      ],
      'check-file/folder-naming-convention': [
        'error',
        {
          '{src,tests}/**': 'KEBAB_CASE',
        },
      ],
      /**
       * @see https://typescript-eslint.io/rules/naming-convention/
       * A collection of rules for consistent identifier naming
       */
      '@typescript-eslint/naming-convention': [
        'error',
        {
          selector: [
            'accessor',
            'parameter',
            'classProperty',
            'classMethod',
            'variable',
          ],
          // Prefer camelCase but allow PascalCase or UPPER_CASE for global variables
          format: ['camelCase', 'PascalCase', 'UPPER_CASE'],
          // Allow underscore for unused variables
          leadingUnderscore: 'allow',
        },
        {
          selector: ['function'],
          // React components should be PascalCase, otherwise camelCase
          format: ['PascalCase', 'camelCase'],
        },
        {
          selector: ['class', 'interface'],
          format: ['PascalCase'],
        },
        {
          selector: ['enum'],
          format: ['PascalCase'],
        },
        {
          selector: ['enumMember'],
          format: ['UPPER_CASE'],
        },
        {
          // Ensure private class attributes are identified by leading underscore
          selector: ['accessor', 'classProperty', 'classMethod'],
          modifiers: ['private'],
          format: null,
          leadingUnderscore: 'require',
          trailingUnderscore: 'forbid',
        },
        {
          // Ensure protected class attributes are identified by leading underscore
          selector: ['accessor', 'classProperty', 'classMethod'],
          modifiers: ['protected'],
          format: null,
          leadingUnderscore: 'require',
          trailingUnderscore: 'forbid',
        },
        {
          // Ensure protected class attributes do not have leading/trailing underscore
          selector: ['accessor', 'classProperty', 'classMethod'],
          modifiers: ['public'],
          format: null,
          leadingUnderscore: 'forbid',
          trailingUnderscore: 'forbid',
        },
        {
          // Ensure all other identifiers do not have leading/trailing underscore
          selector: [
            'class',
            'enum',
            'enumMember',
            'function',
            'interface',
            'objectLiteralMethod',
            'objectLiteralProperty',
            'typeAlias',
            'typeMethod',
            'typeParameter',
            'typeProperty',
            'variable',
          ],
          format: null,
          leadingUnderscore: 'forbid',
          trailingUnderscore: 'forbid',
        },
      ],
    },
  },
  {
    // Allow migration files to start with numbers
    files: ['**/migrations/**/*.{ts,mts,cts}'],
    rules: {
      'check-file/filename-naming-convention': [
        'error',
        {
          '**/migrations/**/*.{ts,mts,cts}': '+([0-9])*([a-z0-9-])',
        },
        {
          ignoreMiddleExtensions: true,
        },
      ],
    },
  },
  {
    // Disable strict type checking rules for test files
    // There's no real point in making sure JSON outputs are a certain type
    // When the test file is about to check it.
    files: ['**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/unbound-method': 'off',
    },
  },
]);
