import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  GAP_MARKER,
  NO_TRANSLATIONS_MESSAGE,
  type TranslatedSegment,
  type TranslationSample,
  TranslationService,
  TranslationStatus,
} from '#src/translation-service.js';

import {
  type FakeTranslatorApi,
  installFakeTranslatorApi,
} from './fake-translator-api.js';

/** A caption long enough that two of them cannot share one batch. */
const LONG_CAPTION = 'word '.repeat(60).trim(); // 299 chars

/** Collects segments emitted by a service, for assertion. */
function collectSegments(service: TranslationService): TranslatedSegment[] {
  const segments: TranslatedSegment[] = [];
  service.on('segment', (segment) => segments.push(segment));
  return segments;
}

/** Collects latency samples emitted by a service, for assertion. */
function collectSamples(service: TranslationService): TranslationSample[] {
  const samples: TranslationSample[] = [];
  service.on('sample', (sample) => samples.push(sample));
  return samples;
}

describe('TranslationService', () => {
  let fake: FakeTranslatorApi;
  let service: TranslationService;

  beforeEach(() => {
    vi.useFakeTimers();
    fake = installFakeTranslatorApi();
  });

  afterEach(() => {
    service.destroy();
    fake.uninstall();
    vi.useRealTimers();
  });

  describe('when the browser has no Translator API', () => {
    beforeEach(() => {
      fake.uninstall();
      service = new TranslationService();
    });

    it('reports itself unsupported so the UI can hide the whole feature', () => {
      expect(service.isSupported).toBe(false);
      expect(service.state.status).toBe(TranslationStatus.UNSUPPORTED);
    });

    it('offers no languages rather than an unusable picker', async () => {
      await expect(service.probeLanguages()).resolves.toEqual([]);
    });

    it('absorbs enable() and submit() instead of throwing at the caller', async () => {
      await expect(service.enable('es')).resolves.toBe(false);
      expect(() => {
        service.submit('hello');
      }).not.toThrow();
      expect(service.state.status).toBe(TranslationStatus.UNSUPPORTED);
    });
  });

  describe('language probing', () => {
    beforeEach(() => {
      service = new TranslationService();
    });

    it('offers only languages the browser did not reject', async () => {
      fake.configure({
        availability: {
          es: 'available',
          fr: 'downloadable',
          ja: 'unavailable',
        },
      });
      const languages = await service.probeLanguages();
      const codes = languages.map((language) => language.code);

      expect(codes).toContain('es');
      expect(codes).toContain('fr');
      expect(codes).not.toContain('ja');
    });

    it('marks not-yet-downloaded languages so the UI can warn first', async () => {
      fake.configure({ availability: { es: 'available', fr: 'downloadable' } });
      const languages = await service.probeLanguages();

      expect(
        languages.find((language) => language.code === 'es')?.requiresDownload,
      ).toBe(false);
      expect(
        languages.find((language) => language.code === 'fr')?.requiresDownload,
      ).toBe(true);
    });

    it('drops languages whose availability check throws', async () => {
      // Chrome throws RangeError for a tag its build does not recognise; the
      // picker must lose that language, not fail to render.
      (globalThis as { Translator?: unknown }).Translator = {
        availability: () => {
          throw new RangeError('Invalid language tag');
        },
        create: () => Promise.reject(new Error('unused')),
      };
      const throwing = new TranslationService();

      await expect(throwing.probeLanguages()).resolves.toEqual([]);
      throwing.destroy();
    });
  });

  describe('enabling', () => {
    beforeEach(() => {
      service = new TranslationService();
    });

    it('creates a translator for the transcript language pair', async () => {
      await service.enable('es');

      expect(fake.createCalls).toEqual([
        { sourceLanguage: 'en', targetLanguage: 'es' },
      ]);
      expect(service.state.status).toBe(TranslationStatus.READY);
    });

    it('reports download progress while the model is fetched', async () => {
      fake.configure({ downloadProgress: [0, 0.5] });
      const states: TranslationStatus[] = [];
      service.on('stateChange', (state) => states.push(state.status));

      await service.enable('es');

      expect(states).toContain(TranslationStatus.DOWNLOADING);
      expect(service.state.status).toBe(TranslationStatus.READY);
      // Progress is cleared on success so no stale bar is left on screen.
      expect(service.state.downloadProgress).toBeNull();
    });

    it('surfaces an unsupported pair as an error the user can read', async () => {
      fake.configure({ createFailsWith: 'NotSupportedError' });

      await expect(service.enable('es')).resolves.toBe(false);
      expect(service.state.status).toBe(TranslationStatus.ERROR);
      expect(service.state.errorMessage).toMatch(/cannot translate into/i);
    });

    it('names the browser as the blocker when the download is refused', async () => {
      fake.configure({ createFailsWith: 'NotAllowedError' });

      await service.enable('es');
      expect(service.state.errorMessage).toMatch(/blocked/i);
    });

    it('releases the previous translator when the language changes', async () => {
      await service.enable('es');
      expect(fake.liveTranslators).toBe(1);

      await service.enable('fr');
      expect(fake.liveTranslators).toBe(1);
      expect(fake.createCalls.at(-1)?.targetLanguage).toBe('fr');
    });
  });

  describe('translating finalized captions', () => {
    beforeEach(async () => {
      service = new TranslationService();
      await service.enable('es');
    });

    it('emits a translated segment for a finalized caption', async () => {
      const segments = collectSegments(service);

      service.submit('Hello there');
      await vi.advanceTimersByTimeAsync(0);

      expect(segments).toHaveLength(1);
      expect(segments[0]).toMatchObject({
        kind: 'text',
        text: '[es] Hello there',
      });
    });

    it('ignores blank captions rather than translating whitespace', async () => {
      const segments = collectSegments(service);

      service.submit('   ');
      service.submit('');
      await vi.advanceTimersByTimeAsync(0);

      expect(fake.translateCalls).toEqual([]);
      expect(segments).toEqual([]);
    });

    it('merges captions queued behind an in-flight call into one request', async () => {
      fake.configure({ translateDelayMs: 1000 });

      service.submit('one');
      await vi.advanceTimersByTimeAsync(0);
      // These pile up while "one" is still being translated.
      service.submit('two');
      service.submit('three');
      await vi.advanceTimersByTimeAsync(2000);

      expect(fake.translateCalls).toEqual(['one', 'two three']);
    });

    it('translates nothing while translation is off', async () => {
      service.disable();
      service.submit('Hello there');
      await vi.advanceTimersByTimeAsync(0);

      expect(fake.translateCalls).toEqual([]);
      expect(service.state.status).toBe(TranslationStatus.OFF);
      expect(fake.liveTranslators).toBe(0);
    });
  });

  describe('when translation falls behind live speech', () => {
    beforeEach(async () => {
      service = new TranslationService();
      await service.enable('es');
    });

    it('drops captions older than the lag budget and marks the gap', async () => {
      // 11s per call: the third caption has waited 22s by the time the queue
      // reaches it, past the 20s budget.
      fake.configure({ translateDelayMs: 11_000 });
      const segments = collectSegments(service);

      service.submit(`first ${LONG_CAPTION}`);
      service.submit(`second ${LONG_CAPTION}`);
      service.submit(`third ${LONG_CAPTION}`);

      await vi.advanceTimersByTimeAsync(40_000);

      expect(fake.translateCalls.some((call) => call.startsWith('first'))).toBe(
        true,
      );
      expect(fake.translateCalls.some((call) => call.startsWith('third'))).toBe(
        false,
      );
      expect(segments.at(-1)).toMatchObject({ kind: 'gap', text: GAP_MARKER });
      expect(service.state.hasDroppedContent).toBe(true);
    });

    it('coalesces consecutive drops into a single gap marker', async () => {
      fake.configure({ translateDelayMs: 11_000 });
      const segments = collectSegments(service);

      for (let i = 0; i < 6; i++) {
        service.submit(`caption ${i.toString()} ${LONG_CAPTION}`);
      }
      await vi.advanceTimersByTimeAsync(120_000);

      const gapRuns = segments.reduce(
        (runs, segment, index) =>
          segment.kind === 'gap' && segments[index - 1]?.kind === 'gap'
            ? runs + 1
            : runs,
        0,
      );
      expect(gapRuns).toBe(0);
    });

    it('counts every dropped caption, not just that some were dropped', async () => {
      fake.configure({ translateDelayMs: 11_000 });

      for (let i = 0; i < 4; i++) {
        service.submit(`caption ${i.toString()} ${LONG_CAPTION}`);
      }
      await vi.advanceTimersByTimeAsync(120_000);

      // One ellipsis stands for several lost captions; the counter does not.
      expect(service.state.droppedCaptions).toBeGreaterThan(1);
    });
  });

  describe('latency samples', () => {
    beforeEach(async () => {
      service = new TranslationService();
      await service.enable('es');
    });

    it('splits queue wait from the translate call', async () => {
      fake.configure({ translateDelayMs: 1000 });
      const samples = collectSamples(service);

      service.submit(`first ${LONG_CAPTION}`);
      await vi.advanceTimersByTimeAsync(0);
      // Queued behind the in-flight call, so it waits out the rest of it.
      service.submit(`second ${LONG_CAPTION}`);
      await vi.advanceTimersByTimeAsync(5000);

      expect(samples).toHaveLength(2);
      expect(samples[0]).toMatchObject({ waitMs: 0, translateMs: 1000 });
      expect(samples[1]?.waitMs).toBeGreaterThan(0);
      expect(samples[1]?.translateMs).toBe(1000);
    });

    it('measures the wait from the oldest caption in the batch', async () => {
      fake.configure({ translateDelayMs: 1000 });
      const samples = collectSamples(service);

      service.submit('first');
      await vi.advanceTimersByTimeAsync(0);
      // Both merge into one call, but "second" is the one that has waited.
      service.submit('second');
      await vi.advanceTimersByTimeAsync(500);
      service.submit('third');
      await vi.advanceTimersByTimeAsync(5000);

      expect(fake.translateCalls).toEqual(['first', 'second third']);
      expect(samples[1]?.waitMs).toBe(1000);
      expect(samples[1]?.captionCount).toBe(2);
    });

    it('reports the backlog left behind after each call', async () => {
      fake.configure({ translateDelayMs: 1000 });
      const samples = collectSamples(service);

      service.submit(`first ${LONG_CAPTION}`);
      await vi.advanceTimersByTimeAsync(0);
      service.submit(`second ${LONG_CAPTION}`);
      service.submit(`third ${LONG_CAPTION}`);
      await vi.advanceTimersByTimeAsync(5000);

      // "second" and "third" are too long to share a batch, so one is left.
      expect(samples[0]?.queuedCaptions).toBe(2);
      expect(samples.at(-1)?.queuedCaptions).toBe(0);
    });

    it('does not sample a call that produced nothing', async () => {
      fake.configure({ translateFailsWith: 'InvalidStateError' });
      const samples = collectSamples(service);

      service.submit('Hello there');
      await vi.advanceTimersByTimeAsync(0);

      // A failure is already surfaced as ERROR plus a gap; timing it would
      // only report the timeout back.
      expect(samples).toEqual([]);
      expect(service.state.status).toBe(TranslationStatus.ERROR);
    });
  });

  describe('when the browser stops producing translations', () => {
    beforeEach(async () => {
      service = new TranslationService();
      await service.enable('es');
    });

    it('reports a visible error when a translation exceeds 20 seconds', async () => {
      fake.configure({ translateDelayMs: 60_000 });
      const segments = collectSegments(service);

      service.submit('Hello there');
      await vi.advanceTimersByTimeAsync(21_000);

      expect(service.state.status).toBe(TranslationStatus.ERROR);
      expect(service.state.errorMessage).toBe(NO_TRANSLATIONS_MESSAGE);
      // The reader is shown a gap, not silence, where the words should be.
      expect(segments.at(-1)).toMatchObject({ kind: 'gap' });
    });

    it('reports an error when translate() rejects outright', async () => {
      fake.configure({ translateFailsWith: 'NotSupportedError' });

      service.submit('Hello there');
      await vi.advanceTimersByTimeAsync(0);

      expect(service.state.status).toBe(TranslationStatus.ERROR);
      expect(service.state.errorMessage).toBe(NO_TRANSLATIONS_MESSAGE);
    });

    it('clears the error once a translation succeeds again', async () => {
      fake.configure({ translateFailsWith: 'UnknownError' });
      service.submit('first');
      await vi.advanceTimersByTimeAsync(0);
      expect(service.state.status).toBe(TranslationStatus.ERROR);

      fake.configure({ translateFailsWith: undefined });
      service.submit('second');
      await vi.advanceTimersByTimeAsync(0);

      expect(service.state.status).toBe(TranslationStatus.READY);
      expect(service.state.errorMessage).toBeNull();
    });
  });

  describe('lifecycle', () => {
    beforeEach(async () => {
      service = new TranslationService();
      await service.enable('es');
    });

    it('clears queued and displayed translations on reset', async () => {
      const cleared = vi.fn();
      service.on('cleared', cleared);

      service.submit('Hello there');
      service.reset();
      await vi.advanceTimersByTimeAsync(0);

      expect(cleared).toHaveBeenCalledOnce();
      expect(service.state.hasDroppedContent).toBe(false);
    });

    it('does not emit captions for a language the user already left', async () => {
      fake.configure({ translateDelayMs: 5000 });
      const segments = collectSegments(service);

      service.submit('Hello there');
      await vi.advanceTimersByTimeAsync(1000);
      await service.enable('fr');
      await vi.advanceTimersByTimeAsync(10_000);

      expect(segments.filter((s) => s.text.includes('[es]'))).toEqual([]);
    });

    it('releases the translator on destroy', () => {
      service.destroy();
      expect(fake.liveTranslators).toBe(0);
    });
  });
});
