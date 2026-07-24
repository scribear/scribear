import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { DrawerMenuGroup } from '#src/components/drawer-menu-group.js';

import { axeViolations } from '../a11y.js';

function renderGroup() {
  return render(
    <DrawerMenuGroup summary="Display" icon={<span data-testid="icon" />}>
      <button type="button">A setting</button>
    </DrawerMenuGroup>,
  );
}

describe('DrawerMenuGroup', (it) => {
  it('names the toggle and exposes its disclosure state', async () => {
    renderGroup();

    // Collapsed: the toggle is an "Expand …" control that is not expanded and
    // points at the (hidden) content region.
    const toggle = screen.getByRole('button', { name: 'Expand Display' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveAttribute('aria-controls');

    // Expanding flips both the name and the state.
    fireEvent.click(toggle);
    expect(
      screen.getByRole('button', { name: 'Collapse Display' }),
    ).toHaveAttribute('aria-expanded', 'true');
  });

  it('renders the summary as a heading', () => {
    renderGroup();
    expect(
      screen.getByRole('heading', { name: 'Display' }),
    ).toBeInTheDocument();
  });

  it('has no axe violations in either state', async () => {
    renderGroup();
    expect(await axeViolations()).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Expand Display' }));
    expect(await axeViolations()).toEqual([]);
  });
});
