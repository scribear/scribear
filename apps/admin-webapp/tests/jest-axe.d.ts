declare module 'jest-axe' {
  import type { AxeResults, ElementContext, RuleObject } from 'axe-core';

  export function axe(
    context: ElementContext,
    options?: { rules?: RuleObject },
  ): Promise<AxeResults>;

  export const toHaveNoViolations: unique symbol;
}
