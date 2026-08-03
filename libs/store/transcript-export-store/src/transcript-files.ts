import type { SummarizationResult } from './summarization-service.js';

/**
 * Formats a local timestamp as `YYYYMMDD-HHMMSS` for use in a filename.
 *
 * Local time, not UTC: the file is named for the moment the person sitting in
 * the room saved it, and a lecture at 14:00 should not land in the file list
 * as 19:00.
 */
export function timestampForFileName(date: Date): string {
  const pad = (value: number) => value.toString().padStart(2, '0');
  return (
    `${date.getFullYear().toString()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/** `transcript-YYYYMMDD-HHMMSS.txt` */
export function transcriptFileName(date: Date): string {
  return `transcript-${timestampForFileName(date)}.txt`;
}

/** `summary-YYYYMMDD-HHMMSS.txt` */
export function summaryFileName(date: Date): string {
  return `summary-${timestampForFileName(date)}.txt`;
}

/** Human-readable local timestamp for a file header. */
function readableTimestamp(date: Date): string {
  const pad = (value: number) => value.toString().padStart(2, '0');
  return (
    `${date.getFullYear().toString()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

/**
 * The transcript file is the transcript, and nothing else.
 *
 * No header, no banner: this is the record. Anything prepended would have to be
 * stripped by every downstream use - a diff, a search, an import into notes -
 * and the filename already carries the timestamp.
 */
export function buildTranscriptFile(transcript: string): string {
  const body = transcript.trim();
  return body === '' ? '' : `${body}\n`;
}

/**
 * The summary file leads with where the summary came from.
 *
 * This is the part of the feature that outlives the UI. A .txt gets mailed,
 * pasted into a ticket, and read months later by someone who never saw the
 * dialog that produced it - and by then "was this uploaded to somebody's
 * server?" and "did a human write this?" are exactly the questions that
 * matter. Both are answered in the file itself, before the content.
 */
export function buildSummaryFile(
  result: SummarizationResult,
  generatedAt: Date,
): string {
  const rule = '='.repeat(72);
  const sections = result.sectionCount.toLocaleString();
  const words = result.sourceWordCount.toLocaleString();
  const passes = result.passes.toString();

  const method =
    result.sectionCount <= 1
      ? `Method:     ${words} words summarized in a single pass.`
      : `Method:     ${words} words split into ${sections} sections; each was ` +
        `summarized\n            separately, then the summaries were ` +
        `summarized together (${passes} ${result.passes === 1 ? 'pass' : 'passes'}).`;

  const caveat = result.converged
    ? ''
    : '\nNOTE:       The transcript was long enough that the summaries stopped\n' +
      '            getting shorter, so what follows is the per-section\n' +
      '            summaries rather than one combined summary.\n';

  return `ScribeAR summary
${rule}

GENERATED LOCALLY, IN YOUR BROWSER.

This summary was produced on this device by your browser's built-in AI model.
The transcript was not uploaded, and no server was contacted to create it.

It is machine-generated and may be wrong or incomplete. The transcript is the
record; this is not.

Generated:  ${readableTimestamp(generatedAt)}
${method}
${caveat}
${rule}

${result.text.trim()}
`;
}

/**
 * Saves `text` as a download named `fileName`.
 *
 * @returns `true` if the download was started. Wrapped rather than throwing
 *   because a blocked or unsupported download must not break the page - the
 *   caller reports it and the transcript stays on screen either way.
 */
export function downloadTextFile(fileName: string, text: string): boolean {
  try {
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    anchor.rel = 'noopener';
    // Appended so the click works in browsers that ignore detached anchors.
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    // Deferred: revoking synchronously can cancel the download that was just
    // started, since the browser has not necessarily read the blob yet.
    setTimeout(() => {
      URL.revokeObjectURL(url);
    }, 60_000);
    return true;
  } catch {
    return false;
  }
}
