import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { MainErrorFallback } from '#src/components/main-error-fallback.js';

import { axeViolations } from '../a11y.js';

describe('MainErrorFallback', (it) => {
  it('announces the error via role=alert and takes focus', () => {
    render(<MainErrorFallback />);

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(/unexpected error/i);
    // Focus is moved to the message so a screen-reader user lands on it.
    expect(alert).toHaveFocus();
  });

  it('has no axe violations', async () => {
    render(<MainErrorFallback />);
    expect(await axeViolations()).toEqual([]);
  });
});
