import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MAX_CHUNK_CHARS,
  MAX_PASSES,
  SummarizationService,
  SummarizationStatus,
} from '#src/summarization-service.js';

import {
  type FakeSummarizerApi,
  QUOTA_CHAR_LIMIT,
  installFakeSummarizerApi,
} from './fake-summarizer-api.js';

/**
 * The feature ships switched off (see `config/feature-flags.ts`), so these
 * tests opt in explicitly. They exist to keep the machinery working for
 * whoever turns it on - the switched-off behaviour has its own tests below.
 */
const ENABLED = { enabled: true };

/** Builds a transcript of roughly `chars` characters of sentence-like text. */
function transcriptOf(chars: number): string {
  const sentence =
    'The scheduler decides which process runs next on the processor. ';
  return sentence.repeat(Math.ceil(chars / sentence.length)).slice(0, chars);
}

describe('SummarizationService', () => {
  let fake: FakeSummarizerApi;
  let service: SummarizationService;

  beforeEach(() => {
    fake = installFakeSummarizerApi();
    service = new SummarizationService(ENABLED);
  });

  afterEach(() => {
    service.destroy();
    fake.uninstall();
  });

  describe('when the browser has no Summarizer API', () => {
    beforeEach(() => {
      service.destroy();
      fake.uninstall();
      service = new SummarizationService(ENABLED);
    });

    it('reports itself unsupported so the summary option is hidden', () => {
      expect(service.isApiPresent).toBe(false);
      expect(service.state.status).toBe(SummarizationStatus.UNSUPPORTED);
    });

    it('absorbs a summarize request instead of throwing at the caller', async () => {
      await expect(service.summarize('some text')).resolves.toBeNull();
    });
  });

  describe('capability checking', () => {
    it('treats an API present but unusable as unsupported', async () => {
      // The API object exists on machines whose hardware cannot host the
      // model; there `availability()` says 'unavailable' and every create()
      // fails with "the service is not running". Presence is not capability.
      fake.configure({ availability: 'unavailable' });

      await expect(service.checkAvailability()).resolves.toBe('unavailable');
      expect(service.state.status).toBe(SummarizationStatus.UNSUPPORTED);
    });

    it('reports when the model still has to be downloaded', async () => {
      fake.configure({ availability: 'downloadable' });

      await expect(service.checkAvailability()).resolves.toBe('downloadable');
      expect(service.state.status).toBe(SummarizationStatus.IDLE);
    });

    it('treats a throwing availability probe as unavailable', async () => {
      (globalThis as { Summarizer?: unknown }).Summarizer = {
        availability: () => {
          throw new TypeError('not a valid enum value');
        },
        create: () => Promise.reject(new Error('unused')),
      };
      const throwing = new SummarizationService(ENABLED);

      await expect(throwing.checkAvailability()).resolves.toBe('unavailable');
      throwing.destroy();
    });
  });

  describe('summarizing a short transcript', () => {
    it('makes a single call and returns its summary', async () => {
      const result = await service.summarize('Alpha beta gamma delta.');

      expect(fake.summarizeCalls).toHaveLength(1);
      expect(result?.sectionCount).toBe(1);
      expect(result?.passes).toBe(1);
      expect(result?.converged).toBe(true);
      expect(result?.text).toContain('Alpha');
    });

    it('counts the source words for the file header', async () => {
      const result = await service.summarize('one two three four five');

      expect(result?.sourceWordCount).toBe(5);
    });

    it('refuses an empty transcript with a readable message', async () => {
      const result = await service.summarize('   \n  ');

      expect(result).toBeNull();
      expect(service.state.status).toBe(SummarizationStatus.ERROR);
      expect(service.state.errorMessage).toMatch(/no transcript/i);
    });

    it('releases the summarizer when the run finishes', async () => {
      await service.summarize('Alpha beta gamma.');

      expect(fake.liveSummarizers).toBe(0);
    });
  });

  describe('summarizing a transcript larger than one request', () => {
    it('splits it into sections and summarizes each', async () => {
      const result = await service.summarize(transcriptOf(MAX_CHUNK_CHARS * 3));

      expect(fake.summarizeCalls.length).toBeGreaterThan(3);
      expect(result?.sectionCount).toBeGreaterThan(2);
      expect(result?.converged).toBe(true);
    });

    it('never hands the model more than it can take', async () => {
      // The whole point of chunking. If any single call exceeds the real
      // quota the fake would have thrown QuotaExceededError, but assert the
      // sizes directly so a regression names itself.
      await service.summarize(transcriptOf(MAX_CHUNK_CHARS * 4));

      const oversized = fake.summarizeCalls.filter(
        (call) => call.length > QUOTA_CHAR_LIMIT,
      );
      expect(oversized).toEqual([]);
    });

    it('recurses: the section summaries are themselves summarized', async () => {
      const result = await service.summarize(transcriptOf(MAX_CHUNK_CHARS * 3));

      // Sections in pass 1, then at least one further call over their joined
      // summaries - that final call is what makes the output one summary
      // rather than a pile of them.
      expect(result?.passes).toBeGreaterThanOrEqual(1);
      expect(fake.summarizeCalls.length).toBeGreaterThan(
        result?.sectionCount ?? 0,
      );
    });

    it('keeps recursing until one call covers what is left', async () => {
      // A weak summarizer needs more reduction rounds than a strong one.
      fake.configure({
        summarizeWith: (input) => {
          const words = input.trim().split(/\s+/);
          return words.slice(0, Math.ceil(words.length * 0.6)).join(' ');
        },
      });

      const result = await service.summarize(transcriptOf(MAX_CHUNK_CHARS * 6));

      expect(result?.passes).toBeGreaterThan(1);
      expect(result?.converged).toBe(true);
    });

    it('cuts sections at sentence boundaries, not mid-word', async () => {
      // A section starting mid-clause is a section the model cannot summarize
      // honestly - it has no way to know the subject of its first sentence is
      // missing. Only the first pass reads the transcript; later passes read
      // summaries, so only the first pass's calls are checked here.
      const result = await service.summarize(transcriptOf(MAX_CHUNK_CHARS * 2));

      const firstPassCalls = fake.summarizeCalls.slice(
        0,
        result?.sectionCount ?? 0,
      );
      expect(firstPassCalls.length).toBeGreaterThan(1);
      for (const call of firstPassCalls) {
        expect(call).toBe(call.trim());
        expect(call.startsWith('The scheduler')).toBe(true);
        expect(call.endsWith('.')).toBe(true);
      }
    });
  });

  describe('when summarizing does not make the text shorter', () => {
    it('stops instead of looping forever', async () => {
      // The real hazard in a recursive reducer: key-point summaries of
      // key-point summaries can hold steady or grow. A naive `while (tooLong)`
      // would never terminate, burning the user's battery on a page they
      // cannot leave without losing their captions.
      fake.configure({ summarizeWith: (input) => input });

      const result = await service.summarize(transcriptOf(MAX_CHUNK_CHARS * 3));

      expect(result).not.toBeNull();
      expect(result?.converged).toBe(false);
      expect(result?.passes).toBeLessThanOrEqual(MAX_PASSES);
    });

    it('still returns the section summaries rather than nothing', async () => {
      fake.configure({ summarizeWith: (input) => input });

      const result = await service.summarize(transcriptOf(MAX_CHUNK_CHARS * 3));

      expect(result?.text.length).toBeGreaterThan(0);
    });

    it('caps the number of passes even when the text shrinks very slowly', async () => {
      fake.configure({
        summarizeWith: (input) => input.slice(0, input.length - 1),
      });

      const result = await service.summarize(transcriptOf(MAX_CHUNK_CHARS * 3));

      expect(result?.passes).toBeLessThanOrEqual(MAX_PASSES);
    });
  });

  describe('when the model rejects a section it was given', () => {
    it('halves the section and carries on rather than failing the run', async () => {
      // The character budget is a guess about tokenisation. When it guesses
      // wrong the run must survive, because the alternative is telling the
      // user their transcript cannot be summarized at all.
      let rejections = 0;
      const realSummarizer = (globalThis as { Summarizer?: unknown })
        .Summarizer as {
        create: (options?: unknown) => Promise<{
          summarize: (input: string, options?: unknown) => Promise<string>;
        }>;
      };
      const originalCreate = realSummarizer.create.bind(realSummarizer);
      realSummarizer.create = async (options?: unknown) => {
        const instance = await originalCreate(options);
        const original = instance.summarize.bind(instance);
        instance.summarize = async (input: string, opts?: unknown) => {
          if (input.length > 4000 && rejections < 3) {
            rejections += 1;
            const error = new Error('The input is too large.');
            error.name = 'QuotaExceededError';
            throw error;
          }
          return original(input, opts);
        };
        return instance;
      };

      const result = await service.summarize(transcriptOf(MAX_CHUNK_CHARS));

      expect(rejections).toBeGreaterThan(0);
      expect(result).not.toBeNull();
      expect(result?.text.length).toBeGreaterThan(0);
    });
  });

  describe('failures', () => {
    it('reports a device that cannot run the model', async () => {
      fake.configure({ createFailsWith: 'NotSupportedError' });

      const result = await service.summarize('Alpha beta gamma.');

      expect(result).toBeNull();
      expect(service.state.status).toBe(SummarizationStatus.ERROR);
      expect(service.state.errorMessage).toMatch(/cannot run/i);
    });

    it('reports a blocked model download', async () => {
      fake.configure({ createFailsWith: 'NotAllowedError' });

      await service.summarize('Alpha beta gamma.');

      expect(service.state.errorMessage).toMatch(/blocked/i);
    });

    it('reports a failure to summarize', async () => {
      fake.configure({ summarizeFailsWith: 'UnknownError' });

      const result = await service.summarize('Alpha beta gamma.');

      expect(result).toBeNull();
      expect(service.state.status).toBe(SummarizationStatus.ERROR);
      expect(service.state.errorMessage).toMatch(/could not be generated/i);
    });

    it('releases the summarizer even when the run fails', async () => {
      fake.configure({ summarizeFailsWith: 'UnknownError' });

      await service.summarize('Alpha beta gamma.');

      expect(fake.liveSummarizers).toBe(0);
    });

    it('reports model download progress', async () => {
      fake.configure({ downloadProgress: [0, 0.5] });
      const statuses: SummarizationStatus[] = [];
      service.on('stateChange', (state) => statuses.push(state.status));

      await service.summarize('Alpha beta gamma.');

      expect(statuses).toContain(SummarizationStatus.DOWNLOADING);
    });
  });

  describe('cancelling', () => {
    it('stops the run and reports no error at the user', async () => {
      vi.useFakeTimers();
      try {
        fake.configure({ summarizeDelayMs: 5000 });
        const run = service.summarize(transcriptOf(MAX_CHUNK_CHARS * 2));
        await vi.advanceTimersByTimeAsync(1000);

        service.cancel();
        await vi.advanceTimersByTimeAsync(20_000);

        await expect(run).resolves.toBeNull();
        expect(service.state.status).toBe(SummarizationStatus.IDLE);
        expect(service.state.errorMessage).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it('is a no-op when nothing is running', () => {
      expect(() => {
        service.cancel();
      }).not.toThrow();
    });
  });

  describe('progress reporting', () => {
    it('reports section and pass numbers so a long run is not a blank wait', async () => {
      const seen: string[] = [];
      service.on('stateChange', (state) => {
        if (state.progress) {
          seen.push(
            `${state.progress.pass.toString()}:${state.progress.completedSections.toString()}/${state.progress.totalSections.toString()}`,
          );
        }
      });

      await service.summarize(transcriptOf(MAX_CHUNK_CHARS * 3));

      expect(seen.length).toBeGreaterThan(2);
      expect(seen[0]).toMatch(/^1:0\/\d+$/);
    });

    it('marks that a run has completed, so later prompts can be shorter', async () => {
      expect(service.state.hasCompletedRun).toBe(false);

      await service.summarize('Alpha beta gamma.');

      expect(service.state.hasCompletedRun).toBe(true);
    });
  });
});
