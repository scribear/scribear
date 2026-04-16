import { useCallback } from 'react';

import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Divider from '@mui/material/Divider';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { QRCodeSVG } from 'qrcode.react';

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

import { selectFontSize, selectShowJoinCode } from '#src/features/cross-screen/stores/display-settings-slice';
import { selectDeviceName } from '#src/features/room-provider/stores/room-config-slice';
import { selectJoinCode } from '#src/features/room-provider/stores/room-service-slice';
import { useAppSelector } from '#src/store/use-redux';

const CLIENT_WEBAPP_URL =
  (import.meta.env['VITE_CLIENT_WEBAPP_URL'] as string | undefined) ??
  `${window.location.origin}/client`;

function buildJoinUrl(joinCode: string): string {
  const config = { clientSessionConfig: { joinCode } };
  const encoded = btoa(JSON.stringify(config));
  return `${CLIENT_WEBAPP_URL}#config=${encoded}`;
}

export const DisplayLive = () => {
  const deviceName = useAppSelector(selectDeviceName);
  const joinCode = useAppSelector(selectJoinCode);
  const showJoinCode = useAppSelector(selectShowJoinCode);

  // fontSize is controlled by the touchscreen via BroadcastChannel / displaySettings
  const fontSize = useAppSelector(selectFontSize);

  // Transcription content
  const commitedSections = useAppSelector(selectCommitedSections);
  const activeSection = useAppSelector(selectActiveSection);
  const inProgressTranscriptionText = useAppSelector(selectInProgressTranscriptionText);

  // Display layout prefs — lineHeight multiplier comes from the user's
  // transcription-display preferences; we apply it to the touchscreen-controlled fontSize.
  const lineHeightMultipler = useAppSelector(selectLineHeightMultipler);
  const wordSpacingEm = useAppSelector(selectWordSpacingEm);
  const targetVerticalPositionPx = useAppSelector(selectTargetVerticalPositionPx);
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

  return (
    <Box
      sx={{
        height: '100vh',
        display: 'flex',
        flexDirection: 'column',
        bgcolor: 'background.default',
      }}
    >
      <Stack
        direction="row"
        alignItems="center"
        justifyContent="space-between"
        px={3}
        py={1}
        sx={{ flexShrink: 0 }}
      >
        <Typography variant="h6">{deviceName ?? 'Room Display'}</Typography>
        <Chip label="Live Transcription" color="error" variant="filled" size="small" />
      </Stack>

      <Divider />

      <Box sx={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        <TranscriptionDisplayProvider>
          <Box sx={{ flex: 1, overflow: 'hidden' }}>
            <TranscriptionDisplayContainer
              commitedSections={commitedSections}
              activeSection={activeSection}
              inProgressTranscriptionText={inProgressTranscriptionText}
              wordSpacingEm={wordSpacingEm}
              fontSizePx={fontSize}
              lineHeightPx={lineHeightPx}
              getBoundedDisplayPreferences={getBoundedDisplayPreferences}
            />
          </Box>
        </TranscriptionDisplayProvider>

        {showJoinCode && joinCode && (
          <Box
            sx={{
              width: 220,
              flexShrink: 0,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              p: 2,
              borderLeft: '1px solid',
              borderColor: 'divider',
              gap: 1,
            }}
          >
            <Typography variant="caption" color="text.secondary" textAlign="center">
              Join with code
            </Typography>
            <Typography variant="h5" fontFamily="monospace" letterSpacing={3}>
              {joinCode}
            </Typography>
            <QRCodeSVG value={buildJoinUrl(joinCode)} size={160} />
          </Box>
        )}
      </Box>
    </Box>
  );
};
