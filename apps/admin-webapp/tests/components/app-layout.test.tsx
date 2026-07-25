import { render } from '@testing-library/react';
import { axe } from 'jest-axe';
import { describe, expect, vi } from 'vitest';

import { AppLayout } from '#src/components/app-layout';
import { useAuth } from '#src/features/auth/auth-context';

import { renderWithProviders } from '../utils/render-with-providers';

vi.mock('#src/features/auth/auth-context', () => ({
  useAuth: vi.fn(),
}));

vi.mock('#src/components/health-indicator', () => ({
  HealthIndicator: () => <span data-testid="health" />,
}));

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

  it('routes the Documentation nav item in-app rather than straight to the wiki', () => {
    // The item sits between two very different kinds of link — Deployment Check
    // (in-app) and the audio meter (external) — and the wiki cards it leads to
    // are themselves `target="_blank"`. Pin that this one navigates the SPA, so
    // it cannot drift into being a sixth external link.
    renderLayout();

    const link = document.querySelector('a[href="/documentation"]');

    expect(link).not.toBeNull();
    expect(link).not.toHaveAttribute('target');
    expect(link?.textContent).toContain('Documentation');
  });

  it('renders the audio meter nav item as an external link that opens a new tab', () => {
    renderLayout();

    const link = document.querySelector('a[href$="audio-meter.html"]');

    expect(link).not.toBeNull();
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(link?.textContent).toContain('Audio meter');
  });

  it('links to the meter root-relatively, so the href does not depend on the current route', () => {
    // A bare `audio-meter.html` resolves against the *current* path, so from a
    // nested route it would point at e.g. /admin/sessions/audio-meter.html —
    // which nginx's SPA fallback serves as index.html, and the router's
    // catch-all then redirects to /. The new tab would silently show the
    // dashboard instead of the meter. The href must be path-independent.
    renderLayout();

    const link = document.querySelector('a[href$="audio-meter.html"]');
    const href = link?.getAttribute('href') ?? '';

    expect(href.startsWith('/')).toBe(true);
    // Resolution from a deep route must land on the same file.
    expect(
      new URL(href, 'https://example.test/admin/sessions/abc-123').pathname,
    ).toBe(new URL(href, 'https://example.test/admin/').pathname);
  });

  it('announces that the external link opens a new tab (SC 3.2.5)', () => {
    renderLayout();

    const link = document.querySelector('a[href$="audio-meter.html"]');

    // Inside the anchor, so it lands in the computed accessible name — the
    // OpenInNewIcon beside it is decorative and carries no text alternative.
    expect(link?.textContent).toContain('(opens in a new tab)');
  });
});
