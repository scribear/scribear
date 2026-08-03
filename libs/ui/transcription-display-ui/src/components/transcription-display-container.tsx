import { memo, useMemo } from 'react';

import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import type { SxProps, Theme } from '@mui/material/styles';

import type {
  ActiveSection,
  TranscriptionSection,
} from '@scribear/transcription-content-store';

import { useTranscriptionDisplayHeight } from '#src/contexts/transcription-display-height-context.js';
import { useAutoScroll } from '#src/hooks/use-auto-scroll.js';
import { useContainerHeight } from '#src/hooks/use-container-height.js';

import { JumpToBottomButton } from './jump-to-bottom-button.js';

/**
 * Props for the internal {@link CommittedSections} component.
 */
interface CommittedSectionsProps {
  // The finalized transcription sections to render as static text.
  sections: TranscriptionSection[];
  // MUI sx styles applied to each section's Typography element.
  textStyle: SxProps<Theme>;
}

// Memoized so active section transcription updates don't update the full committed history.
const CommittedSections = memo(
  ({ sections, textStyle }: CommittedSectionsProps) => (
    <>
      {sections.map((section) => (
        <Typography key={section.id} color="transcriptionColor" sx={textStyle}>
          {section.text}
        </Typography>
      ))}
    </>
  ),
);

/**
 * Bounded display preferences resolved against the current container height.
 */
interface BoundedDisplayPreferences {
  verticalPositionPx: number;
  numDisplayLines: number;
}

/**
 * Props for {@link TranscriptionDisplayContainer}.
 */
export interface TranscriptionDisplayContainerProps {
  // The finalized transcription sections rendered as static committed text.
  commitedSections: TranscriptionSection[];
  // The current in-progress transcription section rendered as live updating text.
  activeSection: ActiveSection;
  // Raw text for the currently streaming transcription chunk, appended after the active section sequences.
  inProgressTranscriptionText: string;
  // Word spacing applied to all transcription text, in em units.
  wordSpacingEm: number;
  // Font size applied to all transcription text, in pixels.
  fontSizePx: number;
  // Line height applied to all transcription text in pixels. Also used to calculate the display area height.
  lineHeightPx: number;
  // Returns the current display preferences (vertical position and line count) clamped to the container height.
  getBoundedDisplayPreferences: (
    containerHeightPx: number,
  ) => BoundedDisplayPreferences;
  // Fill the parent's height instead of the viewport's. Set when the container
  // shares the screen with something else (e.g. the translated caption panel),
  // so the two divide one viewport rather than each claiming all of it.
  fillParentHeight?: boolean;
  // Whether this region announces new text to assistive technology. Defaults to true.
  // Set false when another region on the page (e.g. translated captions) is the
  // one the reader has chosen to follow - two live regions carrying the same
  // speech announce it twice and make both unusable.
  announceUpdates?: boolean;
}

/**
 * Renders the live transcription text with auto-scroll and user preference
 * styling. Reads container height from `TranscriptionDisplayHeightContext`.
 */
export const TranscriptionDisplayContainer = ({
  commitedSections,
  activeSection,
  inProgressTranscriptionText,
  wordSpacingEm,
  fontSizePx,
  lineHeightPx,
  getBoundedDisplayPreferences,
  fillParentHeight = false,
  announceUpdates = true,
}: TranscriptionDisplayContainerProps) => {
  const { containerHeightPx, setContainerHeightPx } =
    useTranscriptionDisplayHeight();
  const containerRef = useContainerHeight(setContainerHeightPx);

  const { verticalPositionPx, numDisplayLines } =
    getBoundedDisplayPreferences(containerHeightPx);
  const displayHeightPx = numDisplayLines * lineHeightPx;

  const {
    isAutoScrollEnabled,
    setIsAutoScrollEnabled,
    textContainerRef,
    textBottomRef,
    handleScroll,
  } = useAutoScroll([
    commitedSections,
    activeSection,
    inProgressTranscriptionText,
    containerHeightPx,
    displayHeightPx,
  ]);

  const textStyle = useMemo<SxProps<Theme>>(
    () => ({
      wordSpacing: `${wordSpacingEm.toString()}em`,
      fontSize: `${fontSizePx.toString()}px`,
      lineHeight: `${lineHeightPx.toString()}px`,
    }),
    [wordSpacingEm, fontSizePx, lineHeightPx],
  );

  return (
    <Box
      sx={{ height: fillParentHeight ? '100%' : '100dvh', width: '100%', p: 2 }}
    >
      <Box ref={containerRef} sx={{ height: '100%' }}>
        <Stack direction="row">
          <Box
            ref={textContainerRef}
            onScroll={handleScroll}
            // Live-caption region for assistive technology. `role="log"` announces
            // only newly appended nodes (finalized/committed sections) and leaves
            // history in place; `polite` queues so it never interrupts the user;
            // `aria-relevant="additions text"` + `aria-atomic="false"` announce just
            // the new node, not the whole transcript. Interim text below is
            // `aria-hidden` so its word-by-word churn is never announced (it is
            // announced exactly once, later, when it becomes a committed section).
            // `tabIndex={0}` makes the region focusable so keyboard + AT users can
            // scroll back through history (arrow/PageUp/PageDown/Home/End) — the
            // scrollbar is visually hidden but the region stays keyboard-scrollable,
            // with a visible focus ring for SC 2.4.7.
            role="log"
            aria-live={announceUpdates ? 'polite' : 'off'}
            aria-relevant="additions text"
            aria-atomic="false"
            aria-label="Live transcription"
            tabIndex={0}
            sx={{
              marginTop: `${verticalPositionPx.toString()}px`,
              height: `${displayHeightPx.toString()}px`,
              width: '100%',
              overflowY: 'scroll',
              '&::-webkit-scrollbar': {
                display: 'none',
              },
              msOverflowStyle: 'none',
              scrollbarWidth: 'none',
              '&:focus-visible': {
                outline: '2px solid',
                outlineColor: 'transcriptionColor',
                outlineOffset: '2px',
              },
            }}
          >
            <CommittedSections
              sections={commitedSections}
              textStyle={textStyle}
            />
            <Typography
              color="transcriptionColor"
              sx={textStyle}
              // Interim/in-progress results change many times per second; feeding
              // that churn to a live region makes speech stutter and a braille
              // display reflow continuously. Hide it from AT — sighted users still
              // see it live, and it is announced once when it moves to a committed
              // section above. (SC 4.1.3, 1.3.1)
              aria-hidden="true"
            >
              {/* Keyed spans so React only appends new nodes — never mutates existing ones,
                  keeping browser re-layout cost proportional to each new chunk. */}
              {activeSection.sequences.map((seq) => (
                <span key={seq.id}>{seq.text.join('')}</span>
              ))}
              <span>{inProgressTranscriptionText}</span>
            </Typography>
            <Box ref={textBottomRef} />
          </Box>
          <JumpToBottomButton
            visible={!isAutoScrollEnabled}
            onClick={() => {
              setIsAutoScrollEnabled(true);
            }}
          />
        </Stack>
      </Box>
    </Box>
  );
};
