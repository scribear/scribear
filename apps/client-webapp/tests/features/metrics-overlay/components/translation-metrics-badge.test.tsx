import { configureStore } from '@reduxjs/toolkit';
import { render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import { describe, expect, it } from 'vitest';

import type {
  TranslationSample,
  TranslationServiceState,
} from '@scribear/live-translation-store';
import {
  TranslationStatus,
  recordTranslationSample,
  setTranslationServiceState,
} from '@scribear/live-translation-store';

import { TranslationMetricsBadge } from '#src/features/metrics-overlay/components/translation-metrics-badge';
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
 * Render the badge over a real store driven the way the middleware drives it:
 * a service state snapshot, then whatever latency samples the case is about.
 */
function renderBadge(options: {
  state?: Partial<TranslationServiceState>;
  samples?: TranslationSample[];
}) {
  const store = configureStore({ reducer: rootReducer });
  store.dispatch(setTranslationServiceState(serviceState(options.state)));
  for (const sample of options.samples ?? []) {
    store.dispatch(recordTranslationSample(sample));
  }
  render(
    <Provider store={store}>
      <TranslationMetricsBadge />
    </Provider>,
  );
}

/** The cell at the intersection of a row and column header. */
function cellFor(rowHeader: string, columnHeader: string): string {
  const table = screen.getByRole('table');
  const columns = [...table.querySelectorAll('thead th')].map(
    (th) => th.textContent,
  );
  const column = columns.indexOf(columnHeader);
  expect(column).toBeGreaterThan(0);
  const row = [...table.querySelectorAll('tbody tr')].find(
    (tr) => tr.querySelector('th')?.textContent === rowHeader,
  );
  expect(row).toBeDefined();
  return row?.children[column]?.textContent ?? '';
}

const sample = (waitMs: number, translateMs: number): TranslationSample => ({
  waitMs,
  translateMs,
  captionCount: 1,
  queuedCaptions: 0,
});

describe('TranslationMetricsBadge', () => {
  it('renders nothing on a browser that cannot translate', () => {
    renderBadge({ state: { status: TranslationStatus.UNSUPPORTED } });
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('shows the card with no data yet, so the overlay explains itself', () => {
    renderBadge({ state: { status: TranslationStatus.OFF } });

    expect(cellFor('Total', 'Last')).toBe('—');
    expect(screen.getByText(/off/)).toBeInTheDocument();
    expect(screen.getByText(/0 calls/)).toBeInTheDocument();
  });

  it('splits queue wait from the model call and totals them', () => {
    renderBadge({ samples: [sample(200, 300)] });

    expect(cellFor('Wait', 'Last')).toBe('200');
    expect(cellFor('Translate', 'Last')).toBe('300');
    expect(cellFor('Total', 'Last')).toBe('500');
  });

  it('shows the newest sample beside its moving average', () => {
    renderBadge({ samples: [sample(100, 100), sample(300, 100)] });

    expect(cellFor('Wait', 'Last')).toBe('300');
    expect(cellFor('Wait', 'Avg')).toBe('200');
    expect(screen.getByText(/2 calls/)).toBeInTheDocument();
  });

  it('reports the backlog and dropped captions alongside the timings', () => {
    renderBadge({
      state: { hasDroppedContent: true, droppedCaptions: 7 },
      samples: [{ ...sample(100, 100), queuedCaptions: 3 }],
    });

    expect(screen.getByText(/queued 3/)).toBeInTheDocument();
    expect(screen.getByText(/dropped 7/)).toBeInTheDocument();
  });
});
