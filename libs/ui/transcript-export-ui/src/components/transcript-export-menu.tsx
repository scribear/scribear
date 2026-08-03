import { useState } from 'react';

import DownloadIcon from '@mui/icons-material/Download';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import LinearProgress from '@mui/material/LinearProgress';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

import { ChoiceModal, DrawerMenuGroup } from '@scribear/core-ui';
import type { SummarizationProgress } from '@scribear/transcript-export-store';

/**
 * The claim that has to survive being read out of context.
 *
 * Summarization sends nothing anywhere, and that is the single most important
 * thing to tell someone about to hand a lecture transcript to an "AI". It
 * appears on the menu, in the confirmation dialog, and at the top of the saved
 * file - three places, because a user who reads only one of them still learns
 * it.
 */
export const LOCAL_SUMMARY_NOTICE =
  'Summaries are generated locally, by your browser, on this device. Nothing is uploaded.';

/** Machine-generated output always says so. */
export const SUMMARY_DISCLAIMER =
  'Machine-generated - may be wrong or incomplete.';

/**
 * Props for {@link TranscriptExportMenu}.
 */
export interface TranscriptExportMenuProps {
  // Approximate word count of the transcript. Zero disables both downloads and
  // explains why, rather than offering a button that saves an empty file.
  transcriptWordCount: number;
  // Whether the browser reported that it can actually run the summarizer.
  // False omits every summary control - the API is present on devices whose
  // hardware cannot host the model, and a button there could only fail.
  isSummarizationOffered: boolean;
  // Whether the model still has to be downloaded before the first run.
  needsModelDownload: boolean;
  // Whether a summary has already completed this session.
  hasCompletedRun: boolean;
  // Whether a run is in flight.
  isSummarizing: boolean;
  // Section/pass progress of the run in flight, or null.
  progress: SummarizationProgress | null;
  // Model download progress in 0..1, or null when not downloading.
  downloadProgress: number | null;
  // A summary already produced this session, offered for saving again.
  hasSavedSummary: boolean;
  // User-visible export error, or null.
  errorMessage: string | null;
  // Saves the transcript as `transcript-YYYYMMDD-HHMMSS.txt`.
  onDownloadTranscript: () => void;
  // Starts a summary run. Called from the confirm click, so the browser still
  // sees user activation for the model download.
  onRequestSummary: () => void;
  // Saves the last summary again.
  onDownloadLastSummary: () => void;
  // Cancels the run in flight.
  onCancelSummary: () => void;
  // Dismisses the error currently shown.
  onDismissError: () => void;
}

/** What the confirmation dialog has to say before the first summary. */
function summaryConfirmationMessage(
  needsModelDownload: boolean,
  hasCompletedRun: boolean,
  wordCount: number,
): string {
  const scale =
    wordCount > 4000
      ? ` This transcript is about ${wordCount.toLocaleString()} words, so it will be summarized in sections and may take several minutes.`
      : '';

  if (needsModelDownload) {
    return (
      `${LOCAL_SUMMARY_NOTICE} To do that, your browser must first download ` +
      `its built-in AI model - a one-time download of roughly 1.8 GB, needing ` +
      `several GB of free disk space and an unmetered connection.${scale} ` +
      SUMMARY_DISCLAIMER
    );
  }
  if (!hasCompletedRun) {
    return (
      `${LOCAL_SUMMARY_NOTICE} The first summary can take a minute or more ` +
      `while the model starts up.${scale} ${SUMMARY_DISCLAIMER}`
    );
  }
  return `${LOCAL_SUMMARY_NOTICE}${scale} ${SUMMARY_DISCLAIMER}`;
}

/** "Section 3 of 7" / "Combining summaries (pass 2), section 1 of 2". */
function progressLabel(progress: SummarizationProgress): string {
  const position = `section ${progress.completedSections + 1 > progress.totalSections ? progress.totalSections.toString() : (progress.completedSections + 1).toString()} of ${progress.totalSections.toString()}`;
  return progress.pass === 1
    ? `Summarizing ${position}...`
    : `Combining summaries (pass ${progress.pass.toString()}), ${position}...`;
}

/**
 * Drawer menu group for saving the transcript and an on-device summary.
 *
 * The summary controls are absent, not disabled, unless the browser has said it
 * can run the model.
 */
export const TranscriptExportMenu = ({
  transcriptWordCount,
  isSummarizationOffered,
  needsModelDownload,
  hasCompletedRun,
  isSummarizing,
  progress,
  downloadProgress,
  hasSavedSummary,
  errorMessage,
  onDownloadTranscript,
  onRequestSummary,
  onDownloadLastSummary,
  onCancelSummary,
  onDismissError,
}: TranscriptExportMenuProps) => {
  const [isConfirmOpen, setIsConfirmOpen] = useState(false);
  const hasTranscript = transcriptWordCount > 0;

  return (
    <DrawerMenuGroup summary="Save Transcript" icon={<DownloadIcon />}>
      <Stack spacing={1} sx={{ alignItems: 'stretch' }}>
        <Button
          variant="outlined"
          startIcon={<DownloadIcon />}
          disabled={!hasTranscript}
          onClick={onDownloadTranscript}
        >
          Download transcript (.txt)
        </Button>

        <Typography variant="caption" component="p" color="text.secondary">
          {hasTranscript
            ? `${transcriptWordCount.toLocaleString()} words so far.`
            : 'Nothing has been transcribed yet.'}
        </Typography>

        {isSummarizationOffered && (
          <>
            <Box sx={{ pt: 2 }}>
              <Button
                variant="outlined"
                startIcon={<DownloadIcon />}
                disabled={!hasTranscript || isSummarizing}
                onClick={() => {
                  setIsConfirmOpen(true);
                }}
                fullWidth
              >
                Download summary (.txt)
              </Button>
            </Box>

            {/* Stated on the menu itself, not only inside the dialog, so it is
                visible to someone who never opens the dialog. */}
            <Typography variant="caption" component="p" color="text.secondary">
              {`${LOCAL_SUMMARY_NOTICE} ${SUMMARY_DISCLAIMER}`}
            </Typography>

            {isSummarizing && (
              <Box role="status" sx={{ pt: 1 }}>
                <Typography variant="body2" component="p">
                  {downloadProgress !== null
                    ? "Downloading your browser's built-in AI model..."
                    : progress
                      ? progressLabel(progress)
                      : 'Starting the on-device summarizer...'}
                </Typography>
                {downloadProgress !== null ? (
                  <LinearProgress
                    variant="determinate"
                    value={Math.round(downloadProgress * 100)}
                    aria-label="AI model download"
                  />
                ) : progress && progress.totalSections > 0 ? (
                  <LinearProgress
                    variant="determinate"
                    value={Math.round(
                      (progress.completedSections / progress.totalSections) *
                        100,
                    )}
                    aria-label="Summary progress"
                  />
                ) : (
                  <LinearProgress />
                )}
                <Button size="small" onClick={onCancelSummary} sx={{ mt: 1 }}>
                  Cancel
                </Button>
              </Box>
            )}

            {hasSavedSummary && !isSummarizing && (
              // The automatic save happens minutes after the click that asked
              // for it, when the page no longer has user activation and the
              // browser may refuse it. This is the fresh click that works.
              <Button size="small" onClick={onDownloadLastSummary}>
                Save the last summary again
              </Button>
            )}
          </>
        )}

        {errorMessage !== null && (
          <Alert severity="error" onClose={onDismissError} sx={{ mt: 1 }}>
            {errorMessage}
          </Alert>
        )}
      </Stack>

      <ChoiceModal
        isOpen={isConfirmOpen}
        message={summaryConfirmationMessage(
          needsModelDownload,
          hasCompletedRun,
          transcriptWordCount,
        )}
        rightAction={
          needsModelDownload ? 'Download model and summarize' : 'Summarize'
        }
        onCancel={() => {
          setIsConfirmOpen(false);
        }}
        onRightAction={() => {
          setIsConfirmOpen(false);
          onRequestSummary();
        }}
      />
    </DrawerMenuGroup>
  );
};
