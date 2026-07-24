import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { AppLayout } from '#src/components/app-layout.js';

import { axeViolations } from '../a11y.js';

function renderLayout(props: Partial<Parameters<typeof AppLayout>[0]> = {}) {
  return render(
    <AppLayout
      isHeaderHideEnabled={false}
      onToggleHeaderHide={vi.fn()}
      drawerContent={<div>Drawer body</div>}
      {...props}
    >
      <div>Main content</div>
    </AppLayout>,
  );
}

describe('AppLayout', (it) => {
  it('provides a single app <h1> and a skip link', () => {
    renderLayout();
    expect(
      screen.getByRole('heading', { level: 1, name: 'ScribeAR' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'Skip to main content' }),
    ).toBeInTheDocument();
  });

  it('names the icon buttons and exposes toggle state', () => {
    renderLayout();
    expect(
      screen.getByRole('button', { name: 'Open Menu' }),
    ).toBeInTheDocument();
    // Autohide currently disabled -> the button offers to enable it, unpressed.
    const autohide = screen.getByRole('button', {
      name: 'Enable Header Autohide',
    });
    expect(autohide).toHaveAttribute('aria-pressed', 'false');
  });

  it('opens the drawer as a dialog named by its heading', () => {
    renderLayout();
    fireEvent.click(screen.getByRole('button', { name: 'Open Menu' }));

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleName('Menu');
    expect(
      screen.getByRole('heading', { level: 2, name: 'Menu' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Close Menu' }),
    ).toBeInTheDocument();
  });

  it('has no axe violations with the drawer open', async () => {
    renderLayout();
    fireEvent.click(screen.getByRole('button', { name: 'Open Menu' }));
    expect(await axeViolations()).toEqual([]);
  });
});
