/**
 * Caption-accuracy proxy for the synthetic canary.
 *
 * Because the canary streams a *known* recording, the transcript it gets back
 * can be scored without any ground-truth infrastructure. This is deliberately a
 * **proxy**, not a WER benchmark:
 *
 * - It is bag-of-words. Word order, punctuation and casing are discarded, so a
 *   scrambled transcript scores as well as a correct one. It answers "are the
 *   right words coming back", which is what distinguishes a healthy pipeline
 *   from a hallucinating or silent one — not "how good is this model".
 * - **Recall is the headline number.** The failures worth alerting on (dead
 *   upstream, VAD eating everything, model fallback to garbage) all show up as
 *   missing ground-truth words. Precision is reported too, because a collapse
 *   in precision with healthy recall is the hallucination/repetition signature.
 *
 * Do not present these numbers as accuracy in the ASR-research sense. They are
 * a health signal with a stable baseline: what matters is the delta from the
 * score a known-good deployment produces on the same fixture.
 */

/** Scores produced by {@link scoreTranscript}. */
export interface AccuracyScore {
  /**
   * Fraction of distinct ground-truth words that appeared. The primary signal:
   * this is what falls when captions stop or degrade.
   */
  recall: number;
  /**
   * Fraction of distinct transcript words that were expected. Falls when the
   * model invents words — the hallucination signature.
   */
  precision: number;
  /** Harmonic mean of the two, for a single sortable number. */
  f1: number;
  /** Distinct ground-truth words that never appeared. Useful for eyeballing. */
  missing: string[];
  expectedWordCount: number;
  actualWordCount: number;
}

/**
 * Words too common to carry signal, stripped before scoring.
 *
 * Without this a transcript of pure filler ("the a to of and…") scores
 * respectable recall against almost any English fixture, which would mask
 * exactly the degradation the canary exists to catch.
 */
const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'but',
  'by',
  'for',
  'from',
  'had',
  'has',
  'have',
  'he',
  'her',
  'his',
  'in',
  'is',
  'it',
  'its',
  'of',
  'on',
  'or',
  'she',
  'that',
  'the',
  'they',
  'this',
  'to',
  'was',
  'were',
  'will',
  'with',
  'you',
]);

/**
 * Normalizes text to a comparable word set.
 *
 * Apostrophes are stripped rather than treated as separators so `it's` becomes
 * `its` on both sides of the comparison; ASR output and written ground truth
 * disagree about contractions constantly, and that disagreement is not a
 * pipeline fault.
 */
export function normalizeWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/['’]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0 && !STOP_WORDS.has(word));
}

/**
 * Scores a transcript against the known script.
 *
 * Comparison is over distinct words. Repetition is therefore invisible here —
 * a transcript that repeats one correct sentence forever scores perfect
 * precision. That specific failure is caught by the separate repetition check
 * in {@link repetitionRatio}, not by this function.
 */
export function scoreTranscript(
  expected: string,
  actual: string,
): AccuracyScore {
  const expectedWords = new Set(normalizeWords(expected));
  const actualWords = new Set(normalizeWords(actual));

  const missing: string[] = [];
  let matched = 0;
  for (const word of expectedWords) {
    if (actualWords.has(word)) matched++;
    else missing.push(word);
  }

  let correctlyProduced = 0;
  for (const word of actualWords) {
    if (expectedWords.has(word)) correctlyProduced++;
  }

  // An empty side scores zero rather than dividing by zero. Zero is the honest
  // answer: no captions means no accuracy, and that must alert.
  const recall = expectedWords.size === 0 ? 0 : matched / expectedWords.size;
  const precision =
    actualWords.size === 0 ? 0 : correctlyProduced / actualWords.size;
  const f1 =
    recall + precision === 0
      ? 0
      : (2 * recall * precision) / (recall + precision);

  return {
    recall,
    precision,
    f1,
    missing,
    expectedWordCount: expectedWords.size,
    actualWordCount: actualWords.size,
  };
}

/**
 * Fraction of transcript words that are duplicates of a word already seen.
 *
 * Whisper's classic degradation is looping the same phrase, which leaves recall
 * and precision untouched (every word is a real word from the script) while the
 * captions are plainly broken. A ratio near 1 with healthy precision is that
 * failure; normal speech sits well below it.
 */
export function repetitionRatio(actual: string): number {
  const words = normalizeWords(actual);
  if (words.length === 0) return 0;
  const distinct = new Set(words).size;
  return 1 - distinct / words.length;
}
