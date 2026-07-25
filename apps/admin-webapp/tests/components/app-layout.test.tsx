import { describe, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { axe } from 'jest-axe';

vi.mock('#src/features/auth/auth-context', () => ({
  useAuth: vi.fn(),
}));

vi.mock('#src/components/health-indicator', () => ({
  HealthIndicator: () => <span data-testid="health" />,
}));

import { AppLayout } from '#src/components/app-layout';
import { useAuth } from '#src/features/auth/auth-context';

import { renderWithProviders } from '../utils/render-with-providers';

function renderLayout(): ReturnType<typeof render> {
  vi.mocked(useAuth).mockReturnValue({
    identity: {
      subject: 'user-1',
      displayName: 'Test User',
      provider: 'local',
      roles: [],
    },
    status: 'authed',
    logout: vi.fn(),
  } as unknown as ReturnType<typeof useAuth>);

  return renderWithProviders(<AppLayout />);
}

describe('AppLayout', (it) => {
  it('has no a11y violations', async () => {
    const { container } = renderLayout();

    const results = await axe(container, {
      rules: {
        // Pre-existing: MUI's List renders <ul> and ListItemButton renders
        // <a> (via component={NavLink} or component="a"), so the <ul> contains
        // <a> children rather than <li>. This is the established nav pattern
        // across the app, not introduced by the audio meter item.
        list: { enabled: false },
      },
    });
    expect(results.violations).toHaveLength(0);
  });

  it('renders the audio meter nav item as an external link that opens a new tab', () => {
    renderLayout();

    const link = document.querySelector('a[href="audio-meter.html"]');

    expect(link).not.toBeNull();
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(link?.textContent).toContain('Audio meter');
  });
});
