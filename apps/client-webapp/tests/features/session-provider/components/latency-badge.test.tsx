import { configureStore } from '@reduxjs/toolkit';
import { render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import { describe, expect, it } from 'vitest';

import type { LatencySample } from '@scribear/transcription-content-store';
import { recordLatency } from '@scribear/transcription-content-store';

import { LatencyBadge } from '#src/features/session-provider/components/latency-badge';
import { rootReducer } from '#src/store/store';

/**
 * Render the badge over a real store fed the given latency samples - the same
 * path the session transport uses.
 */
function renderWithSamples(samples: LatencySample[]) {
  const store = configureStore({ reducer: rootReducer });
  for (const sample of samples) store.dispatch(recordLatency(sample));
  render(
    <Provider store={store}>
      <LatencyBadge />
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

describe('LatencyBadge', () => {
  it('renders nothing before any sample arrives', () => {
    renderWithSamples([]);
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('labels both axes and puts each value in its own cell', () => {
    renderWithSamples([
      { kind: 'final', pipelineMs: 300, e2eMs: 500 },
      { kind: 'inProgress', pipelineMs: 100, e2eMs: 200 },
    ]);

    expect(cellFor('Pipeline', 'Final')).toBe('300');
    expect(cellFor('Pipeline', 'Interim')).toBe('100');
    expect(cellFor('End-To-End', 'Final')).toBe('500');
    expect(cellFor('End-To-End', 'Interim')).toBe('200');
  });

  it('shows an em dash for end-to-end until the source clock is synced', () => {
    renderWithSamples([{ kind: 'final', pipelineMs: 300, e2eMs: null }]);

    expect(cellFor('Pipeline', 'Final')).toBe('300');
    expect(cellFor('End-To-End', 'Final')).toBe('—');
  });

  it('averages repeated samples of the same kind', () => {
    renderWithSamples([
      { kind: 'final', pipelineMs: 100, e2eMs: null },
      { kind: 'final', pipelineMs: 200, e2eMs: null },
    ]);

    expect(cellFor('Pipeline', 'Final')).toBe('150');
  });
});
