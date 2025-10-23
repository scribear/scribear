/**
 * @see https://prettier.io/docs/configuration
 * @type {import("prettier").Config}
 *
 * This config object configures Prettier
 * Prettier is a code formatter that helps mantain a consistent code style through our project
 * This helps:
 * - Make code easier to read
 * - Avoid commiting "invisible" code changes caused by differences in developer environments (editor, OS, preferences)
 */
const config = {
  tabWidth: 2,
  useTabs: false,
  endOfLine: 'lf',
  printWidth: 80,

  semi: true,
  singleQuote: true,
  jsxSingleQuote: false,

  // Enforce import grouping and ordering
  importOrder: [
    '^react(.*)',
    '^@mui/(.*)',
    '<THIRD_PARTY_MODULES>',
    '@scribear/(.*)',
    '^[(./|../)]',
  ],
  importOrderSeparation: true,
  importOrderSortSpecifiers: true,
  plugins: ['@trivago/prettier-plugin-sort-imports'],
};

export default config;
