import { configureStore } from '@reduxjs/toolkit';
import { render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterEach, describe, expect, it } from 'vitest';

import type { TranslationServiceState } from '@scribear/live-translation-store';
import {
  TranslationStatus,
  recordTranslationSample,
  setTranslationServiceState,
} from '@scribear/live-translation-store';
import { recordLatency } from '@scribear/transcription-content-store';

import { MetricsOverlayContainer } from '#src/features/metrics-overlay/components/metrics-overlay-container';
import { rootReducer } from '#src/store/store';

function serviceState(
  overrides: Partial<TranslationServiceState> = {},
): TranslationServiceState {
  return {
    status: TranslationStatus.READY,
    targetLanguage: 'es',
    downloadProgress: null,
    errorMessage: null,
    hasDroppedContent: false,
    droppedCaptions: 0,
    ...overrides,
  };
}

/**
 * Render the overlay with the fragment the reader arrived on, over a real
 * store fed through the same actions the middlewares dispatch.
 */
function renderOverlay(options: {
  hash: string;
  translation?: Partial<TranslationServiceState>;
}) {
  window.location.hash = options.hash;
  const store = configureStore({ reducer: rootReducer });
  store.dispatch(setTranslationServiceState(serviceState(options.translation)));
  store.dispatch(recordLatency({ kind: 'final', pipelineMs: 300, e2eMs: 500 }));
  store.dispatch(
    recordTranslationSample({
      waitMs: 200,
      translateMs: 120,
      captionCount: 1,
      queuedCaptions: 4,
    }),
  );
  render(
    <Provider store={store}>
      <MetricsOverlayContainer />
    </Provider>,
  );
}

function cards(): string[] {
  return screen.queryAllByRole('table').map((table) => {
    const label = table.getAttribute('aria-label') ?? '';
    return label.split(' ')[0] ?? '';
  });
}

afterEach(() => {
  window.location.hash = '';
});

describe('MetricsOverlayContainer', () => {
  it('shows nothing without a fragment asking for it', () => {
    renderOverlay({ hash: '' });
    expect(cards()).toEqual([]);
  });

  it('shows only the requested card', () => {
    renderOverlay({ hash: '#metrics=latency' });
    expect(cards()).toEqual(['Transcription']);
  });

  it('stacks every card for "all"', () => {
    renderOverlay({ hash: '#metrics=all' });
    expect(cards()).toEqual(['Transcription', 'Translation']);
  });

  it('wires the store through to the figures on screen', () => {
    renderOverlay({ hash: '#metrics=all' });

    // 300ms pipeline / 500ms end-to-end, and a 200 + 120ms translation.
    expect(screen.getByText('300')).toBeInTheDocument();
    expect(screen.getByText('500')).toBeInTheDocument();
    // Total appears twice: with one sample, "last" and "avg" agree.
    expect(screen.getAllByText('320')).toHaveLength(2);
    expect(screen.getByText(/queued 4/)).toBeInTheDocument();
    expect(screen.getByText(/ready/)).toBeInTheDocument();
  });

  it('omits translation metrics on a browser that cannot translate', () => {
    renderOverlay({
      hash: '#metrics=all',
      translation: { status: TranslationStatus.UNSUPPORTED },
    });
    expect(cards()).toEqual(['Transcription']);
  });
});
