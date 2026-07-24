import { describe, expect } from 'vitest';

import demoFixture from '#src/server/features/demo-room/fixtures/alice-chapter-v.utterances.json' with { type: 'json' };

/**
 * Guards the checked-in fixture so it cannot rot: the emitter trusts these
 * invariants (non-overlapping, ordered, known speakers, non-empty spoken text)
 * rather than re-validating at runtime.
 */
const ALLOWED_SPEAKERS = new Set(['caterpillar', 'alice', 'pigeon']);

describe('alice-chapter-v.utterances fixture', (it) => {
  it('has the advertised speakers, count, and Gutenberg attribution', () => {
    expect(demoFixture.speakers).toStrictEqual([
      'caterpillar',
      'alice',
      'pigeon',
    ]);
    expect(demoFixture.utterances).toHaveLength(demoFixture.utteranceCount);
    expect(demoFixture.utterances.length).toBeGreaterThan(0);
    expect(demoFixture.source.attribution).toMatch(/Project Gutenberg/i);
    expect(demoFixture.loop).toBe(true);
  });

  it('has a valid, forward window for every utterance', () => {
    for (const u of demoFixture.utterances) {
      expect(u.start).toBeGreaterThanOrEqual(0);
      expect(u.end).toBeGreaterThan(u.start);
      expect(u.spoken.trim().length).toBeGreaterThan(0);
      expect(typeof u.progresstxt).toBe('string');
      expect(ALLOWED_SPEAKERS.has(u.speaker)).toBe(true);
    }
  });

  it('is ordered and non-overlapping', () => {
    for (let i = 1; i < demoFixture.utterances.length; i++) {
      const prev = demoFixture.utterances[i - 1];
      const curr = demoFixture.utterances[i];
      expect(curr?.start).toBeGreaterThanOrEqual(prev?.end ?? 0);
    }
  });
});
