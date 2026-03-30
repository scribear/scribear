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
    <Box sx={{ height: '100dvh', width: '100%', p: 2 }}>
      <Box ref={containerRef} sx={{ height: '100%' }}>
        <Stack direction="row">
          <Box
            ref={textContainerRef}
            onScroll={handleScroll}
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
            }}
          >
            <CommittedSections
              sections={commitedSections}
              textStyle={textStyle}
            />
            <Typography color="transcriptionColor" sx={textStyle}>
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
