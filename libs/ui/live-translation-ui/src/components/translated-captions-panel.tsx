import { useEffect, useRef } from 'react';

import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import LinearProgress from '@mui/material/LinearProgress';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import type { SxProps, Theme } from '@mui/material/styles';

import {
  type TranslatedSegment,
  TranslationStatus,
} from '@scribear/live-translation-store';

/**
 * Wording required on every translated caption view. Machine translation of
 * live speech is unreviewed by anyone, and a reader relying on captions has
 * no other way to know the text is not a human transcript.
 */
export const TRANSLATION_DISCLAIMER =
  'In-browser translation - may contain errors';

/**
 * Props for {@link TranslatedCaptionsPanel}.
 */
export interface TranslatedCaptionsPanelProps {
  // Translated caption segments, oldest first. Gap segments mark dropped content.
  segments: TranslatedSegment[];
  // Current translation status; drives the download and error affordances.
  status: TranslationStatus;
  // BCP-47 tag being translated into. Sets `lang` so screen readers and
  // hyphenation use the right language.
  targetLanguage: string;
  // Human-readable name of the target language, for headings and messages.
  targetLanguageLabel: string;
  // Model download progress in 0..1, or null when not downloading.
  downloadProgress: number | null;
  // User-visible failure text, or null when healthy.
  errorMessage: string | null;
  // Word spacing applied to caption text, in em units.
  wordSpacingEm: number;
  // Font size applied to caption text, in pixels.
  fontSizePx: number;
  // Line height applied to caption text, in pixels.
  lineHeightPx: number;
  // Height of the scrolling caption area, in pixels.
  displayHeightPx?: number;
}

/**
 * Renders translated captions beneath the original transcript.
 *
 * The original transcript is never replaced. Translation is best-effort and
 * unreviewed, so the source text has to stay available for anyone who needs to
 * check what was actually said - and it is what later summarisation would run
 * against.
 */
export const TranslatedCaptionsPanel = ({
  segments,
  status,
  targetLanguage,
  targetLanguageLabel,
  downloadProgress,
  errorMessage,
  wordSpacingEm,
  fontSizePx,
  lineHeightPx,
  displayHeightPx = 160,
}: TranslatedCaptionsPanelProps) => {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [segments]);

  const textStyle: SxProps<Theme> = {
    wordSpacing: `${wordSpacingEm.toString()}em`,
    fontSize: `${fontSizePx.toString()}px`,
    lineHeight: `${lineHeightPx.toString()}px`,
  };

  const isDownloading = status === TranslationStatus.DOWNLOADING;
  const isPreparing = status === TranslationStatus.PREPARING;

  return (
    <Box
      sx={{
        width: '100%',
        px: 2,
        pb: 1,
        borderTop: 1,
        borderColor: 'divider',
      }}
    >
      <Stack
        direction="row"
        sx={{
          alignItems: 'baseline',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          columnGap: 2,
          pt: 1,
        }}
      >
        <Typography variant="subtitle2" component="h2">
          {`Translation (${targetLanguageLabel})`}
        </Typography>
        <Typography variant="caption" component="p" color="text.secondary">
          {TRANSLATION_DISCLAIMER}
        </Typography>
      </Stack>

      {(isDownloading || isPreparing) && (
        <Box sx={{ py: 1 }} role="status">
          <Typography variant="body2" component="p">
            {isDownloading
              ? `Downloading the ${targetLanguageLabel} language model...`
              : `Starting ${targetLanguageLabel} translation...`}
          </Typography>
          {/* Determinate only once the browser has reported progress; an
              indeterminate bar is honest about not knowing yet. */}
          {downloadProgress === null ? (
            <LinearProgress />
          ) : (
            <LinearProgress
              variant="determinate"
              value={Math.round(downloadProgress * 100)}
              aria-label={`${targetLanguageLabel} model download`}
            />
          )}
        </Box>
      )}

      {errorMessage !== null && (
        <Alert severity="error" sx={{ my: 1 }}>
          {errorMessage}
        </Alert>
      )}

      <Box
        // The reader turned translation on, so this is the region they are
        // following - it announces, and the original transcript region is
        // switched to `aria-live="off"` by the app so the same speech is not
        // announced twice. `lang` is what makes a screen reader pronounce the
        // text with the right voice instead of reading Spanish as English.
        role="log"
        aria-live="polite"
        aria-relevant="additions text"
        aria-atomic="false"
        aria-label={`Translated captions, ${targetLanguageLabel}`}
        lang={targetLanguage}
        tabIndex={0}
        sx={{
          height: `${displayHeightPx.toString()}px`,
          overflowY: 'auto',
          '&:focus-visible': {
            outline: '2px solid',
            outlineColor: 'transcriptionColor',
            outlineOffset: '2px',
          },
        }}
      >
        <Typography color="transcriptionColor" sx={textStyle}>
          {segments.map((segment) => (
            <span
              key={segment.id}
              // Gap markers stand in for captions dropped to catch up with the
              // speaker. Dimming them keeps a reader from mistaking the
              // ellipsis for something that was said.
              style={segment.kind === 'gap' ? { opacity: 0.6 } : undefined}
            >
              {segment.text}{' '}
            </span>
          ))}
        </Typography>
        <Box ref={bottomRef} />
      </Box>
    </Box>
  );
};
