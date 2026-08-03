import { configureStore } from '@reduxjs/toolkit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { appInitialization } from '@scribear/redux-remember-store';
import { transcriptionContentReducer } from '@scribear/transcription-content-store';

import { IS_SUMMARIZATION_ENABLED } from '#src/config/feature-flags.js';
import {
  SummarizationService,
  SummarizationStatus,
} from '#src/summarization-service.js';
import { createTranscriptExportMiddleware } from '#src/transcript-export-middleware.js';
import {
  requestSummary,
  selectIsSummarizationOffered,
  transcriptExportReducer,
} from '#src/transcript-export-slice.js';

import {
  type FakeSummarizerApi,
  installFakeSummarizerApi,
} from './fake-summarizer-api.js';

/**
 * The switched-off path — what users actually get today.
 *
 * The rest of the suite opts in with `{ enabled: true }` to keep the machinery
 * covered; this file pins the default. A fully working summarizer is installed
 * throughout, so every assertion here is about the switch and nothing else.
 */
describe('summarization feature flag', () => {
  let fake: FakeSummarizerApi;
  let service: SummarizationService;

  beforeEach(() => {
    fake = installFakeSummarizerApi({ availability: 'available' });
    service = new SummarizationService();
  });

  afterEach(() => {
    service.destroy();
    fake.uninstall();
  });

  it('ships switched off', () => {
    // If this ever fails, the checklist in `config/feature-flags.ts` was
    // supposed to have been worked through first.
    expect(IS_SUMMARIZATION_ENABLED).toBe(false);
  });

  it('reports itself unsupported even where the browser could summarize', () => {
    expect(service.isApiPresent).toBe(false);
    expect(service.state.status).toBe(SummarizationStatus.UNSUPPORTED);
  });

  it('never touches the browser API', async () => {
    // Not merely hidden: switched off means no availability probe on page load
    // and no model work, on a device that would happily do both.
    await service.checkAvailability();
    await service.summarize('Some transcript worth summarizing.');

    expect(fake.summarizeCalls).toEqual([]);
    expect(fake.liveSummarizers).toBe(0);
  });

  it('produces no summary to save', async () => {
    await expect(
      service.summarize('Some transcript worth summarizing.'),
    ).resolves.toBeNull();
  });

  it('withholds the summary option from the store', async () => {
    const store = configureStore({
      reducer: {
        transcriptionContent: transcriptionContentReducer,
        transcriptExport: transcriptExportReducer,
      },
      middleware: (getDefaultMiddleware) =>
        getDefaultMiddleware().concat(
          createTranscriptExportMiddleware(service),
        ),
    });

    store.dispatch(appInitialization());
    store.dispatch(requestSummary());
    await new Promise((resolve) => setTimeout(resolve, 10));

    // This selector is what removes every summary control from the menu.
    expect(selectIsSummarizationOffered(store.getState())).toBe(false);
    expect(fake.summarizeCalls).toEqual([]);
  });

  it('can be switched on without touching anything else', () => {
    // The whole point of a flag over a deletion: one argument revives it.
    const enabled = new SummarizationService({ enabled: true });

    expect(enabled.isApiPresent).toBe(true);
    expect(enabled.state.status).toBe(SummarizationStatus.IDLE);
    enabled.destroy();
  });

  it('leaves the transcript download alone', async () => {
    // The flag gates summarization only. Saving the transcript costs nothing
    // and does not depend on any model.
    const { buildTranscriptFile, transcriptFileName } =
      await import('#src/transcript-files.js');

    expect(buildTranscriptFile('Hello there.')).toBe('Hello there.\n');
    expect(transcriptFileName(new Date(2026, 7, 2, 14, 5, 9))).toBe(
      'transcript-20260802-140509.txt',
    );
  });
});

// Guards the override itself: a typo in the option name would silently leave
// every other test in this package exercising the disabled path, and they
// would all still pass while testing nothing.
describe('the enabled override', () => {
  it('is honoured, so the rest of the suite is not vacuous', () => {
    const fake = installFakeSummarizerApi();
    const off = new SummarizationService();
    const on = new SummarizationService({ enabled: true });

    expect(off.isApiPresent).toBe(false);
    expect(on.isApiPresent).toBe(true);

    off.destroy();
    on.destroy();
    fake.uninstall();
    vi.restoreAllMocks();
  });
});
