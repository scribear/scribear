import { describe, expect } from 'vitest';

import {
  normalizeWords,
  repetitionRatio,
  scoreTranscript,
} from '#src/server/shared/canary/transcript-accuracy.js';

const SCRIPT = 'The birch canoe slid on the smooth planks.';

describe('transcript accuracy', () => {
  describe('normalizeWords', (it) => {
    it('lowercases, strips punctuation and drops stop words', () => {
      // Act
      const words = normalizeWords(
        'The birch canoe slid on the smooth planks.',
      );

      // Assert — "the" and "on" carry no signal and are removed.
      expect(words).toStrictEqual([
        'birch',
        'canoe',
        'slid',
        'smooth',
        'planks',
      ]);
    });

    it('folds contractions so ASR and written text agree', () => {
      // Arrange — ASR output and written ground truth disagree about
      // apostrophes constantly; that is not a pipeline fault.
      expect(normalizeWords("it's easy")).toStrictEqual(
        normalizeWords('its easy'),
      );
    });
  });

  describe('scoreTranscript', (it) => {
    it('scores a perfect transcript as 1.0', () => {
      // Act
      const score = scoreTranscript(SCRIPT, SCRIPT);

      // Assert
      expect(score.recall).toBe(1);
      expect(score.precision).toBe(1);
      expect(score.f1).toBe(1);
      expect(score.missing).toStrictEqual([]);
    });

    it('is insensitive to word order, casing and punctuation', () => {
      // Arrange — this is a bag-of-words health proxy, not a WER benchmark.
      const scrambled = 'PLANKS, smooth! slid canoe birch';

      // Act
      const score = scoreTranscript(SCRIPT, scrambled);

      // Assert
      expect(score.recall).toBe(1);
    });

    it('reports zero recall when no captions came back at all', () => {
      // Arrange — the headline A2 failure. Zero, not undefined, so the alert
      // rule has a value to compare.
      const score = scoreTranscript(SCRIPT, '');

      // Assert
      expect(score.recall).toBe(0);
      expect(score.precision).toBe(0);
      expect(score.missing).toHaveLength(5);
    });

    it('drops recall proportionally when words go missing', () => {
      // Act — 3 of the 5 signal words survive.
      const score = scoreTranscript(SCRIPT, 'the birch canoe slid');

      // Assert
      expect(score.recall).toBeCloseTo(0.6, 5);
      expect(score.missing.sort()).toStrictEqual(['planks', 'smooth']);
    });

    it('drops precision but not recall when the model invents words', () => {
      // Arrange — the hallucination signature: everything expected is present,
      // plus a pile of words that were never spoken.
      const hallucinated = `${SCRIPT} subscribe to my channel and click the bell icon now`;

      // Act
      const score = scoreTranscript(SCRIPT, hallucinated);

      // Assert
      expect(score.recall).toBe(1);
      expect(score.precision).toBeLessThan(0.5);
    });

    it('does not credit a transcript made only of filler words', () => {
      // Arrange — without stop-word removal this scores respectable recall
      // against almost any English script, masking the exact degradation the
      // canary exists to catch.
      const score = scoreTranscript(SCRIPT, 'the the a to of and is it on');

      // Assert
      expect(score.recall).toBe(0);
    });
  });

  describe('repetitionRatio', (it) => {
    it('is near zero for normal speech', () => {
      // Act / Assert
      expect(repetitionRatio(SCRIPT)).toBeLessThan(0.1);
    });

    it('approaches one when the model loops a phrase', () => {
      // Arrange — recall and precision both stay perfect here, which is why
      // this needs its own detector.
      const looped = Array.from({ length: 20 }, () => SCRIPT).join(' ');

      // Act
      const ratio = repetitionRatio(looped);

      // Assert
      expect(ratio).toBeGreaterThan(0.9);
      expect(scoreTranscript(SCRIPT, looped).precision).toBe(1);
    });

    it('is zero for an empty transcript rather than NaN', () => {
      // Act / Assert
      expect(repetitionRatio('')).toBe(0);
    });
  });
});
