import { describe, expect, it } from 'vitest';

import type { SummarizationResult } from '#src/summarization-service.js';
import {
  buildSummaryFile,
  buildTranscriptFile,
  summaryFileName,
  transcriptFileName,
} from '#src/transcript-files.js';

// Local time, deliberately not UTC - see timestampForFileName.
const AT = new Date(2026, 7, 2, 14, 5, 9);

const RESULT: SummarizationResult = {
  text: '- The lecture covered process scheduling.',
  sourceWordCount: 9412,
  sectionCount: 5,
  passes: 2,
  converged: true,
};

describe('file names', () => {
  it('names the transcript transcript-YYYYMMDD-HHMMSS.txt', () => {
    expect(transcriptFileName(AT)).toBe('transcript-20260802-140509.txt');
  });

  it('names the summary summary-YYYYMMDD-HHMMSS.txt', () => {
    expect(summaryFileName(AT)).toBe('summary-20260802-140509.txt');
  });

  it('zero-pads every field', () => {
    expect(transcriptFileName(new Date(2026, 0, 3, 4, 5, 6))).toBe(
      'transcript-20260103-040506.txt',
    );
  });

  it('uses local time, so the name matches the clock in the room', () => {
    // A 14:00 lecture must not be filed as 19:00 because the machine is in
    // UTC-5. The name is for the person who was there.
    const local = new Date(2026, 7, 2, 14, 0, 0);
    expect(transcriptFileName(local)).toContain('-1400');
  });
});

describe('buildTranscriptFile', () => {
  it('is the transcript and nothing else', () => {
    // No header: this is the record. Anything prepended has to be stripped by
    // every downstream use - a diff, a search, an import into notes.
    expect(buildTranscriptFile('First para.\n\nSecond para.')).toBe(
      'First para.\n\nSecond para.\n',
    );
  });

  it('is empty for an empty transcript', () => {
    expect(buildTranscriptFile('   ')).toBe('');
  });
});

describe('buildSummaryFile', () => {
  it('says the summary was generated locally, in the browser', () => {
    const file = buildSummaryFile(RESULT, AT);

    expect(file).toContain('GENERATED LOCALLY, IN YOUR BROWSER.');
    expect(file).toMatch(/was not uploaded/i);
    expect(file).toMatch(/no server was contacted/i);
  });

  it('puts the provenance before the content', () => {
    // The .txt outlives the dialog that produced it. Someone reading it months
    // later, in a mail thread, must not have to scroll to learn where it came
    // from.
    const file = buildSummaryFile(RESULT, AT);

    expect(file.indexOf('GENERATED LOCALLY')).toBeLessThan(
      file.indexOf(RESULT.text),
    );
  });

  it('says the summary is machine-generated and may be wrong', () => {
    const file = buildSummaryFile(RESULT, AT);

    expect(file).toMatch(/machine-generated/i);
    expect(file).toMatch(/transcript is the\s+record/i);
  });

  it('records when it was generated and from how much', () => {
    const file = buildSummaryFile(RESULT, AT);

    expect(file).toContain('2026-08-02 14:05:09');
    expect(file).toContain('9,412 words');
    expect(file).toContain('5 sections');
    expect(file).toContain('2 passes');
  });

  it('describes a single-pass run without section arithmetic', () => {
    const file = buildSummaryFile(
      { ...RESULT, sectionCount: 1, passes: 1 },
      AT,
    );

    expect(file).toContain('in a single pass');
    expect(file).not.toContain('sections');
  });

  it('says so when the summaries stopped getting shorter', () => {
    // An honest file: the reader is holding per-section summaries, not one
    // combined summary, and nothing else in the file would reveal that.
    const file = buildSummaryFile({ ...RESULT, converged: false }, AT);

    expect(file).toMatch(/stopped\s+getting shorter/i);
  });

  it('says nothing about convergence when it converged', () => {
    expect(buildSummaryFile(RESULT, AT)).not.toMatch(/stopped/i);
  });

  it('ends with the summary text', () => {
    expect(buildSummaryFile(RESULT, AT).trimEnd().endsWith(RESULT.text)).toBe(
      true,
    );
  });
});
