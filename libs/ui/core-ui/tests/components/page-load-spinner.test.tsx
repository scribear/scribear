import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { PageLoadSpinner } from '#src/components/page-load-spinner.js';

import { axeViolations } from '../a11y.js';

describe('PageLoadSpinner', (it) => {
  it('announces loading with a named status region', () => {
    render(<PageLoadSpinner />);
    expect(screen.getByRole('status')).toBeInTheDocument();
    // The progressbar carries the accessible name for AT.
    expect(screen.getByRole('progressbar')).toHaveAccessibleName('Loading');
  });

  it('has no axe violations', async () => {
    render(<PageLoadSpinner />);
    expect(await axeViolations()).toEqual([]);
  });
});
