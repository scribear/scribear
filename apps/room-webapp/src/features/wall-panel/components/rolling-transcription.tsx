import { useCallback, useMemo } from 'react';

import GraphicEqIcon from '@mui/icons-material/GraphicEq';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Typography from '@mui/material/Typography';

import {
  selectActiveSection,
  selectCommitedSections,
  selectInProgressTranscriptionText,
} from '@scribear/transcription-content-store';
import {
  deriveDisplayPreferences,
  selectLineHeightMultipler,
  selectTargetDisplayLines,
  selectTargetVerticalPositionPx,
  selectWordSpacingEm,
} from '@scribear/transcription-display-store';
import {
  TranscriptionDisplayContainer,
  TranscriptionDisplayProvider,
} from '@scribear/transcription-display-ui';

import {
  selectFontSize,
  setFontSize,
} from '#src/features/cross-screen/stores/display-settings-slice';
import { useAppDispatch, useAppSelector } from '#src/store/use-redux';

const FONT_PRESETS = [
  { id: 'S', value: 20 },
  { id: 'M', value: 32 },
  { id: 'L', value: 48 },
] as const;

export const RollingTranscription = () => {
  const dispatch = useAppDispatch();
  const commitedSections = useAppSelector(selectCommitedSections);
  const activeSection = useAppSelector(selectActiveSection);
  const inProgressTranscriptionText = useAppSelector(
    selectInProgressTranscriptionText,
  );

  const fontSize = useAppSelector(selectFontSize);
  const lineHeightMultipler = useAppSelector(selectLineHeightMultipler);
  const wordSpacingEm = useAppSelector(selectWordSpacingEm);
  const targetVerticalPositionPx = useAppSelector(
    selectTargetVerticalPositionPx,
  );
  const targetDisplayLines = useAppSelector(selectTargetDisplayLines);

  const lineHeightPx = Math.round(fontSize * lineHeightMultipler);

  const getBoundedDisplayPreferences = useCallback(
    (containerHeightPx: number) =>
      deriveDisplayPreferences(
        lineHeightPx,
        targetVerticalPositionPx,
        targetDisplayLines,
        containerHeightPx,
      ),
    [lineHeightPx, targetVerticalPositionPx, targetDisplayLines],
  );

  const presetValue = useMemo(
    () =>
      FONT_PRESETS.reduce((best, p) =>
        Math.abs(p.value - fontSize) < Math.abs(best.value - fontSize)
          ? p
          : best,
      ).value,
    [fontSize],
  );

  return (
    <Box sx={{ height: '100%', width: '100%', position: 'relative' }}>
      <Stack
        direction="row"
        alignItems="center"
        spacing={0.75}
        sx={{
          position: 'absolute',
          top: 8,
          left: 12,
          zIndex: 1,
          px: 1,
          py: 0.25,
          borderRadius: 999,
          bgcolor: 'rgba(244, 67, 54, 0.15)',
          border: '1px solid rgba(244, 67, 54, 0.45)',
          pointerEvents: 'none',
        }}
      >
        <GraphicEqIcon sx={{ fontSize: 14, color: '#ff8a80' }} />
        <Typography
          variant="caption"
          sx={{ color: '#ff8a80', fontWeight: 700, letterSpacing: 1 }}
        >
          LIVE
        </Typography>
      </Stack>

      <ToggleButtonGroup
        exclusive
        value={presetValue}
        onChange={(_, v) => {
          if (typeof v === 'number') dispatch(setFontSize(v));
        }}
        size="medium"
        sx={{
          position: 'absolute',
          top: 10,
          right: 10,
          zIndex: 1,
          bgcolor: 'rgba(0,0,0,0.75)',
          borderRadius: 2,
          border: '2px solid rgba(255,255,255,0.45) !important',
          boxShadow:
            'inset 0 1px 0 rgba(255,255,255,0.08), 0 4px 16px rgba(0,0,0,0.55)',
          '& .MuiToggleButton-root': {
            minWidth: 52,
            minHeight: 48,
            px: 1.75,
            py: 1,
            fontSize: '1.05rem',
            fontWeight: 800,
            color: 'rgba(255,255,255,0.95)',
            border: '1px solid rgba(255,255,255,0.35) !important',
            '&.Mui-selected': {
              bgcolor: 'primary.main',
              color: '#fff',
              borderColor: 'primary.main !important',
              '&:hover': { bgcolor: 'primary.dark' },
            },
            '&:hover': {
              bgcolor: 'rgba(255,255,255,0.14)',
            },
          },
        }}
      >
        {FONT_PRESETS.map((p) => (
          <ToggleButton
            key={p.id}
            value={p.value}
            aria-label={`${p.id} text size`}
          >
            {p.id}
          </ToggleButton>
        ))}
      </ToggleButtonGroup>

      <TranscriptionDisplayProvider>
        <TranscriptionDisplayContainer
          commitedSections={commitedSections}
          activeSection={activeSection}
          inProgressTranscriptionText={inProgressTranscriptionText}
          wordSpacingEm={wordSpacingEm}
          fontSizePx={fontSize}
          lineHeightPx={lineHeightPx}
          getBoundedDisplayPreferences={getBoundedDisplayPreferences}
        />
      </TranscriptionDisplayProvider>
    </Box>
  );
};
