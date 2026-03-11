import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

import {
  selectActiveSection,
  selectAverageFinalLatency,
  selectAverageInProgressLatency,
  selectCommitedSections,
  selectInProgressTranscriptionText,
} from '#src/core/transcription-content/store/transcription-content-slice';
import { useTranscriptionDisplayHeight } from '#src/features/transcription-display/contexts/transcription-display/transcription-display-context';
import {
  selectBoundedDisplayPreferences,
  selectFontSizePx,
  selectLineHeightPx,
  selectWordSpacingEm,
} from '#src/features/transcription-display/stores/transcription-display-preferences-slice';
import { useAppSelector } from '#src/stores/use-redux';

import { useAutoScroll } from '../hooks/use-auto-scroll';
import { useContainerHeight } from '../hooks/use-container-height';
import { JumpToBottomButton } from './jump-to-bottom-button';

export const TranscriptionDisplayContainer = () => {
  const commitedSections = useAppSelector(selectCommitedSections);
  const activeSection = useAppSelector(selectActiveSection);
  const inProgressTranscriptionText = useAppSelector(
    selectInProgressTranscriptionText,
  );
  const averageFinalLatency = useAppSelector(selectAverageFinalLatency);
  const averageInProgressLatency = useAppSelector(
    selectAverageInProgressLatency,
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

  const formatLatency = (value: number) => {
    if (!Number.isFinite(value) || value <= 0) return '—';
    return Math.round(value).toString();
  };

  return (
    <Box sx={{ height: '100dvh', width: '100%', p: 2, position: 'relative' }}>
      <Box
        sx={{
          position: 'absolute',
          top: 8,
          right: 8,
          px: 1.5,
          py: 0.75,
          borderRadius: 1,
          backgroundColor: 'rgba(0, 0, 0, 0.55)',
          color: '#fff',
          fontSize: '0.75rem',
          lineHeight: 1.2,
          zIndex: 1,
        }}
      >
        <div>Final: {formatLatency(averageFinalLatency)} ms</div>
        <div>In-progress: {formatLatency(averageInProgressLatency)} ms</div>
      </Box>
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
