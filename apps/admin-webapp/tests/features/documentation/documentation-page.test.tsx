import { screen, within } from '@testing-library/react';
import { axe } from 'jest-axe';
import { describe, expect } from 'vitest';

import { DocumentationPage } from '#src/features/documentation/documentation-page';

import { renderWithProviders } from '../../utils/render-with-providers';

/**
 * Title as rendered on the card, and the wiki URL it must resolve to. Written
 * out in full rather than composed from a shared base, so a typo in the page's
 * own `WIKI_BASE`/slug join is something these assertions can actually catch.
 */
const EXPECTED_LINKS: [title: string, href: string][] = [
  ['Deployment', 'https://github.com/scribear/scribear/wiki/Deployment'],
  [
    'Audio Monitoring',
    'https://github.com/scribear/scribear/wiki/Audio-Monitoring',
  ],
  [
    'Audio Telemetry',
    'https://github.com/scribear/scribear/wiki/Audio-Telemetry',
  ],
  ['Admin Website', 'https://github.com/scribear/scribear/wiki/Admin-Website'],
  ['Documentation', 'https://github.com/scribear/scribear/wiki/Documentation'],
];

describe('DocumentationPage', (it) => {
  it('has no a11y violations', async () => {
    const { container } = renderWithProviders(<DocumentationPage />);

    const results = await axe(container);

    expect(results.violations).toHaveLength(0);
  });

  it('renders one card per wiki page, pointing at the right page', () => {
    renderWithProviders(<DocumentationPage />);

    for (const [title, href] of EXPECTED_LINKS) {
      const link = screen.getByRole('link', { name: new RegExp(`^${title}`) });

      expect(link).toHaveAttribute('href', href);
    }
  });

  it('opens every card in a new window, with the opener detached', () => {
    renderWithProviders(<DocumentationPage />);

    const links = screen.getAllByRole('link');

    // Every link on this page is a wiki card; none of them navigate in place.
    expect(links).toHaveLength(EXPECTED_LINKS.length);
    for (const link of links) {
      expect(link).toHaveAttribute('target', '_blank');
      // `noopener` is the load-bearing half: without it the wiki tab gets a
      // handle on `window.opener` and can navigate this authed console.
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    }
  });

  it('gives the page an h1 and each card an h2 (SC 1.3.1, heading-order)', () => {
    renderWithProviders(<DocumentationPage />);

    // The page title carries the `h5` type scale but must be the `h1`, the
    // way every other page in this console does it. The card titles use the
    // `subtitle1` variant, which MUI maps to an `<h6>` element by default —
    // four levels below the page title, which axe reports as heading-order.
    expect(
      screen.getByRole('heading', { level: 1, name: 'Documentation' }),
    ).toBeInTheDocument();
    expect(screen.queryAllByRole('heading', { level: 6 })).toHaveLength(0);
    expect(screen.getAllByRole('heading', { level: 2 })).toHaveLength(
      EXPECTED_LINKS.length,
    );
  });

  it('announces that the cards open a new tab (SC 3.2.5)', () => {
    renderWithProviders(<DocumentationPage />);

    // Inside the anchor, so it lands in the computed accessible name — the
    // OpenInNewIcon on each card is decorative and carries no text alternative,
    // so a screen reader user has nothing else to go on.
    for (const link of screen.getAllByRole('link')) {
      expect(
        within(link).getByText('(opens in a new tab)'),
      ).toBeInTheDocument();
    }
  });
});
