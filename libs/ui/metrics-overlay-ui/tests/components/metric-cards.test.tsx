import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { LatencyMetricsCard } from '#src/components/latency-metrics-card.js';
import { TranslationMetricsCard } from '#src/components/translation-metrics-card.js';

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

describe('LatencyMetricsCard', () => {
  it('renders nothing before anything has been measured', () => {
    render(
      <LatencyMetricsCard
        pipelineFinalMs={0}
        pipelineInterimMs={0}
        e2eFinalMs={0}
        e2eInterimMs={0}
      />,
    );
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('labels both axes and puts each value in its own cell', () => {
    render(
      <LatencyMetricsCard
        pipelineFinalMs={300}
        pipelineInterimMs={100}
        e2eFinalMs={500}
        e2eInterimMs={200}
      />,
    );

    expect(cellFor('Pipeline', 'Final')).toBe('300');
    expect(cellFor('Pipeline', 'Interim')).toBe('100');
    expect(cellFor('End-To-End', 'Final')).toBe('500');
    expect(cellFor('End-To-End', 'Interim')).toBe('200');
  });

  it('shows an em dash for end-to-end until the source clock is synced', () => {
    render(
      <LatencyMetricsCard
        pipelineFinalMs={300}
        pipelineInterimMs={100}
        e2eFinalMs={0}
        e2eInterimMs={0}
      />,
    );

    expect(cellFor('End-To-End', 'Final')).toBe('—');
    expect(cellFor('End-To-End', 'Interim')).toBe('—');
  });
});

const figure = (last: number, average: number) => ({ last, average });

describe('TranslationMetricsCard', () => {
  it('splits queue wait from the model call and shows both averages', () => {
    render(
      <TranslationMetricsCard
        statusLabel="ready"
        wait={figure(300, 200)}
        translate={figure(100, 150)}
        total={figure(400, 350)}
        queuedCaptions={3}
        droppedCaptions={7}
        sampleCount={12}
      />,
    );

    expect(cellFor('Wait', 'Last')).toBe('300');
    expect(cellFor('Wait', 'Avg')).toBe('200');
    expect(cellFor('Translate', 'Last')).toBe('100');
    expect(cellFor('Total', 'Avg')).toBe('350');
  });

  it('reports status and counters alongside the timings', () => {
    render(
      <TranslationMetricsCard
        statusLabel="downloading"
        wait={figure(0, 0)}
        translate={figure(0, 0)}
        total={figure(0, 0)}
        queuedCaptions={2}
        droppedCaptions={5}
        sampleCount={0}
      />,
    );

    expect(screen.getByText(/downloading/)).toBeInTheDocument();
    expect(screen.getByText(/queued 2/)).toBeInTheDocument();
    expect(screen.getByText(/dropped 5/)).toBeInTheDocument();
    expect(screen.getByText(/0 calls/)).toBeInTheDocument();
  });

  it('stays on screen with no samples, so the overlay explains itself', () => {
    render(
      <TranslationMetricsCard
        statusLabel="off"
        wait={figure(0, 0)}
        translate={figure(0, 0)}
        total={figure(0, 0)}
        queuedCaptions={0}
        droppedCaptions={0}
        sampleCount={0}
      />,
    );

    expect(cellFor('Total', 'Last')).toBe('—');
    expect(screen.getByText(/off/)).toBeInTheDocument();
  });
});
