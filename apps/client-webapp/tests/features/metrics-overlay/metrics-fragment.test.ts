import { describe, expect, it } from 'vitest';

import { parseMetricsFragment } from '#src/features/metrics-overlay/metrics-fragment';

describe('parseMetricsFragment', () => {
  it('requests nothing when the fragment is absent or unrelated', () => {
    expect(parseMetricsFragment('')).toEqual(new Set());
    expect(parseMetricsFragment('#')).toEqual(new Set());
    expect(parseMetricsFragment('#joinCode=ABC123')).toEqual(new Set());
  });

  it('accepts a named metric with or without the leading hash', () => {
    expect(parseMetricsFragment('#metrics=latency')).toEqual(
      new Set(['latency']),
    );
    expect(parseMetricsFragment('metrics=latency')).toEqual(
      new Set(['latency']),
    );
  });

  it('expands "all" to every known overlay', () => {
    expect(parseMetricsFragment('#metrics=all')).toEqual(
      new Set(['latency', 'translation']),
    );
  });

  it('reads a comma-separated list, ignoring unknown names', () => {
    expect(parseMetricsFragment('#metrics=latency,translation')).toEqual(
      new Set(['latency', 'translation']),
    );
    expect(parseMetricsFragment('#metrics=latency,dropouts')).toEqual(
      new Set(['latency']),
    );
    expect(parseMetricsFragment('#metrics=dropouts')).toEqual(new Set());
  });

  it('tolerates whitespace, casing, and empty entries', () => {
    expect(parseMetricsFragment('#metrics= LaTeNcY , ,')).toEqual(
      new Set(['latency']),
    );
  });

  it('coexists with other fragment parameters', () => {
    expect(parseMetricsFragment('#foo=bar&metrics=latency')).toEqual(
      new Set(['latency']),
    );
  });

  it('leaves the url-config fragment alone', () => {
    // Base64 payloads carry `=` padding; that must not read as a metric.
    expect(parseMetricsFragment('#config=eyJmb28iOiJiYXIifQ==')).toEqual(
      new Set(),
    );
  });
});
