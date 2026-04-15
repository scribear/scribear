import eslintReact from '@eslint-react/eslint-plugin';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import { defineConfig } from 'eslint/config';

import baseConfig from '../../eslint.config.js';

export default defineConfig([
  ...baseConfig,
  {
    files: ['**/*.{ts,mts,cts,tsx}'],
    extends: [
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
      eslintReact.configs['recommended-type-checked'],
    ],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          name: 'react-redux',
          importNames: ['useSelector', 'useDispatch'],
          message:
            'Use typed hooks `useAppDispatch` and `useAppSelector` instead.',
        },
      ],
    },
  },
]);
