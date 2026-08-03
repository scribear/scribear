import { screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { TranslationLanguageOption } from '@scribear/live-translation-store';

import { LiveTranslationMenu } from '#src/components/live-translation-menu.js';

import { axeViolations } from '../a11y.js';
import { renderWithProviders } from '../render.js';

const LANGUAGES: TranslationLanguageOption[] = [
  {
    code: 'es',
    label: 'Spanish',
    availability: 'available',
    requiresDownload: false,
  },
  {
    code: 'fr',
    label: 'French',
    availability: 'downloadable',
    requiresDownload: true,
  },
];

function renderMenu(
  overrides: Partial<Parameters<typeof LiveTranslationMenu>[0]> = {},
) {
  const props = {
    isSupported: true,
    isEnabled: false,
    targetLanguage: 'es',
    languages: LANGUAGES,
    onEnable: vi.fn(),
    onDisable: vi.fn(),
    onChangeLanguage: vi.fn(),
    ...overrides,
  };
  renderWithProviders(<LiveTranslationMenu {...props} />);
  return props;
}

/**
 * Expands the drawer group so its controls are reachable.
 *
 * The group's toggle is the icon button, not the heading text - a click on the
 * heading leaves the content collapsed, where `getByRole` cannot see it.
 */
async function openGroup(user: ReturnType<typeof userEvent.setup>) {
  await user.click(
    screen.getByRole('button', { name: 'Expand Translated Captions' }),
  );
}

describe('LiveTranslationMenu', () => {
  it('renders nothing at all when the browser cannot translate', () => {
    // Not a disabled control: a browser without the API offers the user no
    // path forward, so the whole affordance is absent rather than teasing.
    const { container } = renderWithProviders(
      <LiveTranslationMenu
        isSupported={false}
        isEnabled={false}
        targetLanguage="es"
        languages={LANGUAGES}
        onEnable={vi.fn()}
        onDisable={vi.fn()}
        onChangeLanguage={vi.fn()}
      />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it('defaults to Spanish', async () => {
    const user = userEvent.setup();
    renderMenu();
    await openGroup(user);

    expect(screen.getByLabelText('Language')).toHaveTextContent('Spanish');
  });

  it('does not turn translation on until the user confirms', async () => {
    const user = userEvent.setup();
    const props = renderMenu();
    await openGroup(user);

    await user.click(screen.getByLabelText('Show translated captions'));

    expect(props.onEnable).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Translate' }));
    expect(props.onEnable).toHaveBeenCalledWith('es');
  });

  it('states that the output is machine translated before enabling', async () => {
    const user = userEvent.setup();
    renderMenu();
    await openGroup(user);
    await user.click(screen.getByLabelText('Show translated captions'));

    expect(screen.getByRole('dialog')).toHaveTextContent(
      /In-browser translation - may contain errors/,
    );
  });

  it('warns about the download before spending the user connection', async () => {
    const user = userEvent.setup();
    const props = renderMenu({ targetLanguage: 'fr' });
    await openGroup(user);

    await user.click(screen.getByLabelText('Show translated captions'));

    expect(screen.getByRole('dialog')).toHaveTextContent(
      /one-time language model download/i,
    );
    expect(
      screen.getByRole('button', { name: 'Download and translate' }),
    ).toBeInTheDocument();
    expect(props.onEnable).not.toHaveBeenCalled();
  });

  it('leaves translation on when the confirmation is cancelled', async () => {
    const user = userEvent.setup();
    const props = renderMenu({ isEnabled: true });
    await openGroup(user);

    await user.click(screen.getByLabelText('Show translated captions'));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(props.onDisable).not.toHaveBeenCalled();
  });

  it('confirms before turning translation off', async () => {
    const user = userEvent.setup();
    const props = renderMenu({ isEnabled: true });
    await openGroup(user);

    await user.click(screen.getByLabelText('Show translated captions'));
    expect(screen.getByRole('dialog')).toHaveTextContent(
      /original captions stay on screen/i,
    );

    await user.click(screen.getByRole('button', { name: 'Turn off' }));
    expect(props.onDisable).toHaveBeenCalledOnce();
  });

  it('marks languages that still need a download', async () => {
    const user = userEvent.setup();
    renderMenu();
    await openGroup(user);
    await user.click(screen.getByLabelText('Language'));

    expect(
      screen.getByRole('option', { name: 'French (download required)' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Spanish' })).toBeInTheDocument();
  });

  it('switches language without a prompt while translation is off', async () => {
    const user = userEvent.setup();
    const props = renderMenu();
    await openGroup(user);

    await user.click(screen.getByLabelText('Language'));
    await user.click(
      screen.getByRole('option', { name: 'French (download required)' }),
    );

    expect(props.onChangeLanguage).toHaveBeenCalledWith('fr');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('warns before switching a running translation to a language that must download', async () => {
    const user = userEvent.setup();
    const props = renderMenu({ isEnabled: true });
    await openGroup(user);

    await user.click(screen.getByLabelText('Language'));
    await user.click(
      screen.getByRole('option', { name: 'French (download required)' }),
    );

    expect(props.onChangeLanguage).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toHaveTextContent(
      /one-time language model download/i,
    );

    await user.click(
      screen.getByRole('button', { name: 'Download and translate' }),
    );
    expect(props.onChangeLanguage).toHaveBeenCalledWith('fr');
  });

  it('has no automatically detectable accessibility violations', async () => {
    const user = userEvent.setup();
    renderMenu();
    await openGroup(user);

    expect(await axeViolations()).toEqual([]);
  });
});
