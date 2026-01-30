import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

import { useTranscriptionDisplayHeight } from '@/features/transcription-display/contexts/transcription-display/transcription-display-context';
import {
  selectBoundedDisplayPreferences,
  selectFontSizePx,
  selectLineHeightPx,
  selectWordSpacingEm,
} from '@/features/transcription-display/stores/transcription-display-preferences-slice';
import {
  selectActiveSection,
  selectCommitedSections,
  selectInProgressTranscriptionText,
} from '@/core/transcription-content/store/transcription-content-slice';
import { useAppSelector } from '@/stores/use-redux';

import { useAutoScroll } from '../hooks/use-auto-scroll';
import { useContainerHeight } from '../hooks/use-container-height';
import { JumpToBottomButton } from './jump-to-bottom-button';

export const TranscriptionDisplayContainer = () => {
  const commitedSections = useAppSelector(selectCommitedSections);
  const activeSection = useAppSelector(selectActiveSection);
  const inProgressTranscriptionText = useAppSelector(
    selectInProgressTranscriptionText,
  );

  const { containerHeightPx, setContainerHeightPx } =
    useTranscriptionDisplayHeight();
  const containerRef = useContainerHeight(setContainerHeightPx);

  const wordSpacingEm = useAppSelector(selectWordSpacingEm);
  const fontSizePx = useAppSelector(selectFontSizePx);
  const lineHeightPx = useAppSelector(selectLineHeightPx);
  const { verticalPositionPx, numDisplayLines } = useAppSelector((state) => {
    return selectBoundedDisplayPreferences(state, { containerHeightPx });
  });
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

  const textStyle = {
    wordSpacing: `${wordSpacingEm.toString()}em`,
    fontSize: `${fontSizePx.toString()}px`,
    lineHeight: `${lineHeightPx.toString()}px`,
  };

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
              // Hide scrollbar
              '&::-webkit-scrollbar': {
                display: 'none',
              },
              msOverflowStyle: 'none',
              scrollbarWidth: 'none',
            }}
          >
            {commitedSections.map((section) => (
              <Typography
                key={section.id}
                color="transcriptionColor"
                sx={textStyle}
              >
                {section.text}
              </Typography>
            ))}
            <Typography color="transcriptionColor" sx={textStyle}>
              <span>{activeSection.text}</span>
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
