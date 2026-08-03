/**
 * Splits transcript text into pieces small enough for one summarization call.
 *
 * Pure and synchronous so the hard part - deciding where to cut - is testable
 * without a model. The service layer adds the model-side checks
 * (`measureInputUsage`, and `QuotaExceededError` as a backstop) on top.
 */

/**
 * Greedily packs `text` into chunks of at most `maxChars`, cutting at the
 * largest structural boundary that fits.
 *
 * The boundary ladder is paragraph, then sentence, then whitespace, then a hard
 * character cut. It matters because a summary of a chunk that begins mid-clause
 * is a summary of a fragment: the model has no way to know it is missing the
 * subject of the sentence it was handed.
 *
 * @param text - Text to split. Empty or whitespace-only yields `[]`.
 * @param maxChars - Maximum characters per chunk. Values below 1 are treated
 *   as 1, so a bad caller cannot produce an infinite loop.
 * @returns Non-empty chunks, in order, whose concatenation preserves all
 *   non-whitespace content.
 */
export function splitIntoChunks(text: string, maxChars: number): string[] {
  const limit = Math.max(1, Math.floor(maxChars));
  const trimmed = text.trim();
  if (trimmed === '') return [];
  if (trimmed.length <= limit) return [trimmed];

  const chunks: string[] = [];
  let rest = trimmed;

  while (rest.length > limit) {
    const cut = findCutPoint(rest, limit);
    const head = rest.slice(0, cut).trim();
    if (head !== '') chunks.push(head);
    rest = rest.slice(cut).trim();
  }
  if (rest !== '') chunks.push(rest);

  return chunks;
}

/**
 * Finds the index to cut at, at or before `limit`.
 *
 * Always returns at least 1 so the caller always makes progress - a paragraph
 * boundary at index 0 would otherwise loop forever on the same input.
 */
function findCutPoint(text: string, limit: number): number {
  const window = text.slice(0, limit);

  const paragraphBreak = window.lastIndexOf('\n\n');
  if (paragraphBreak > 0) return paragraphBreak;

  const sentenceBreak = lastSentenceEnd(window);
  if (sentenceBreak > 0) return sentenceBreak;

  const wordBreak = window.search(/\s+\S*$/);
  if (wordBreak > 0) return wordBreak;

  // A single unbroken run longer than the limit (no spaces at all). Cut it.
  return limit;
}

/**
 * Index just past the last sentence terminator in `window`, or -1.
 *
 * Requires the terminator to be followed by whitespace so decimals and
 * abbreviations mid-sentence are not treated as ends.
 */
function lastSentenceEnd(window: string): number {
  const matches = [...window.matchAll(/[.!?]["')\]]*\s/g)];
  const last = matches.at(-1);
  return last?.index === undefined ? -1 : last.index + last[0].length;
}

/**
 * Splits one chunk into two roughly equal halves at a structural boundary.
 *
 * Used when the model rejects a chunk it was handed - the character budget
 * guessed wrong about how the text tokenises, so the chunk has to shrink
 * without re-planning the whole transcript.
 *
 * @returns Two non-empty pieces, or `null` when `text` cannot be divided any
 *   further (a single word), which is the caller's signal to give up rather
 *   than recurse forever.
 */
export function bisect(text: string): [string, string] | null {
  const trimmed = text.trim();
  if (trimmed.length < 2) return null;

  const cut = findCutPoint(trimmed, Math.ceil(trimmed.length / 2));
  const head = trimmed.slice(0, cut).trim();
  const tail = trimmed.slice(cut).trim();
  if (head === '' || tail === '') return null;
  return [head, tail];
}

/** Approximate word count, for progress and file headers. */
export function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed === '' ? 0 : trimmed.split(/\s+/).length;
}
