import { describe, expect } from 'vitest';

import demoFixture from '#src/server/features/demo-room/fixtures/alice-book.utterances.json' with { type: 'json' };

/**
 * Guards the checked-in fixture so it cannot rot: the emitter trusts these
 * invariants (well-formed turns/lines, no accidental adjacent-same-speaker
 * split, Gutenberg attribution) rather than re-validating at runtime.
 */
describe('alice-book.utterances fixture', (it) => {
  it('has a non-empty turn/line count, sorted speakers, and Gutenberg attribution', () => {
    expect(demoFixture.turns).toHaveLength(demoFixture.turnCount);
    expect(demoFixture.turns.length).toBeGreaterThan(0);
    expect(
      demoFixture.turns.reduce((n, t) => n + t.lines.length, 0),
    ).toBe(demoFixture.lineCount);
    expect(demoFixture.speakers).toStrictEqual(
      [...demoFixture.speakers].sort(),
    );
    expect(demoFixture.source.attribution).toMatch(/Project Gutenberg/i);
    expect(demoFixture.loop).toBe(true);
  });

  it('every turn has a known, non-empty speaker and only non-empty lines', () => {
    const knownSpeakers = new Set(demoFixture.speakers);
    for (const turn of demoFixture.turns) {
      expect(turn.speaker.trim().length).toBeGreaterThan(0);
      expect(knownSpeakers.has(turn.speaker)).toBe(true);
      expect(turn.lines.length).toBeGreaterThan(0);
      for (const line of turn.lines) {
        expect(line.trim().length).toBeGreaterThan(0);
        // Stored lines are the spoken words only, no enclosing quote marks.
        expect(line.trim().startsWith('"')).toBe(false);
        expect(line.trim().endsWith('"')).toBe(false);
      }
    }
  });

  it('never splits one speaker turn into two adjacent turns', () => {
    for (let i = 1; i < demoFixture.turns.length; i++) {
      expect(demoFixture.turns[i]?.speaker).not.toBe(
        demoFixture.turns[i - 1]?.speaker,
      );
    }
  });
});
