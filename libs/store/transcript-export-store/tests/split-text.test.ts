import { describe, expect, it } from 'vitest';

import { bisect, countWords, splitIntoChunks } from '#src/utils/split-text.js';

/** Words in `text`, for asserting nothing was lost across a split. */
const words = (text: string) => text.trim().split(/\s+/).filter(Boolean);

describe('splitIntoChunks', () => {
  it('returns nothing for empty or whitespace-only text', () => {
    expect(splitIntoChunks('', 100)).toEqual([]);
    expect(splitIntoChunks('   \n\t ', 100)).toEqual([]);
  });

  it('returns text that already fits as a single chunk', () => {
    expect(splitIntoChunks('Short enough.', 100)).toEqual(['Short enough.']);
  });

  it('never exceeds the limit', () => {
    const text = 'word '.repeat(500);
    for (const chunk of splitIntoChunks(text, 120)) {
      expect(chunk.length).toBeLessThanOrEqual(120);
    }
  });

  it('loses no words', () => {
    const text = Array.from({ length: 200 }, (_, i) =>
      i % 10 === 9 ? `word${i.toString()}.` : `word${i.toString()}`,
    ).join(' ');

    const rejoined = splitIntoChunks(text, 150).join(' ');

    expect(words(rejoined)).toEqual(words(text));
  });

  it('prefers paragraph boundaries', () => {
    const text = `${'a'.repeat(40)}\n\n${'b'.repeat(40)}`;

    const chunks = splitIntoChunks(text, 60);

    expect(chunks).toEqual(['a'.repeat(40), 'b'.repeat(40)]);
  });

  it('falls back to sentence boundaries', () => {
    const text = 'First sentence here. Second sentence here. Third one here.';

    for (const chunk of splitIntoChunks(text, 45)) {
      // Every chunk starts a sentence and ends one.
      expect(chunk).toMatch(/^[A-Z]/);
      expect(chunk.endsWith('.')).toBe(true);
    }
  });

  it('does not treat a decimal point as a sentence end', () => {
    const text = `The value is 3.14 and it matters a great deal here. ${'x'.repeat(60)}`;

    const chunks = splitIntoChunks(text, 70);

    expect(chunks.some((chunk) => chunk.endsWith('3.'))).toBe(false);
  });

  it('falls back to word boundaries when no sentence fits', () => {
    const text = 'alpha bravo charlie delta echo foxtrot golf hotel india';

    for (const chunk of splitIntoChunks(text, 20)) {
      expect(words(text).join(' ')).toContain(chunk);
    }
  });

  it('splits an unbroken run rather than looping forever', () => {
    // A single token longer than the limit has no boundary to cut at. The
    // splitter must still make progress; returning the whole thing would hand
    // the model an input it has already refused.
    const chunks = splitIntoChunks('x'.repeat(250), 100);

    expect(chunks).toHaveLength(3);
    expect(chunks.every((chunk) => chunk.length <= 100)).toBe(true);
  });

  it('makes progress even with a nonsensical limit', () => {
    expect(splitIntoChunks('abc def', 0).join('')).toContain('a');
    expect(splitIntoChunks('abc def', -5).length).toBeGreaterThan(0);
  });

  it('emits no empty chunks', () => {
    const text = `para one.\n\n\n\npara two.\n\n${'z'.repeat(200)}`;

    for (const chunk of splitIntoChunks(text, 50)) {
      expect(chunk.trim()).not.toBe('');
    }
  });
});

describe('bisect', () => {
  it('splits into two non-empty halves', () => {
    const result = bisect('alpha bravo charlie delta echo foxtrot');

    expect(result).not.toBeNull();
    expect(result?.[0].trim()).not.toBe('');
    expect(result?.[1].trim()).not.toBe('');
  });

  it('loses no words', () => {
    const text = 'one two three four five six seven eight nine ten';
    const [head, tail] = bisect(text) ?? ['', ''];

    expect(words(`${head} ${tail}`)).toEqual(words(text));
  });

  it('gives up on text that cannot be divided', () => {
    // The caller's signal to stop recursing rather than retry forever.
    expect(bisect('a')).toBeNull();
    expect(bisect('')).toBeNull();
    expect(bisect('   ')).toBeNull();
  });

  it('divides a single long unbroken token', () => {
    const result = bisect('y'.repeat(100));

    expect(result?.[0].length).toBe(50);
    expect(result?.[1].length).toBe(50);
  });
});

describe('countWords', () => {
  it('counts words, not characters', () => {
    expect(countWords('one two three')).toBe(3);
  });

  it('is zero for empty and whitespace-only text', () => {
    expect(countWords('')).toBe(0);
    expect(countWords('  \n ')).toBe(0);
  });

  it('collapses runs of whitespace', () => {
    expect(countWords(' one \n\n  two\t three ')).toBe(3);
  });
});
