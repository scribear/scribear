import axe from 'axe-core';

// Page-scaffolding rules that only make sense for a whole document, not an
// isolated component rendered into jsdom's bare <body>.
const PAGE_LEVEL_RULES_OFF = {
  region: { enabled: false },
  'landmark-one-main': { enabled: false },
  'page-has-heading-one': { enabled: false },
  'html-has-lang': { enabled: false },
  'document-title': { enabled: false },
  bypass: { enabled: false },
} satisfies Record<string, { enabled: boolean }>;

/**
 * Runs axe-core (WCAG 2.1 A/AA rules) over `node` and returns the ids of any
 * violations, so a test can assert `expect(await axeViolations(el)).toEqual([])`.
 */
export async function axeViolations(
  node: Element = document.body,
): Promise<string[]> {
  const results = await axe.run(node, {
    runOnly: {
      type: 'tag',
      values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'],
    },
    rules: PAGE_LEVEL_RULES_OFF,
  });
  return results.violations.map((v) => `${v.id} (${v.nodes.length} node(s))`);
}
