import { useCallback, useEffect } from 'react';

import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Divider from '@mui/material/Divider';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

import { QRCodeSVG } from 'qrcode.react';

import { createSessionManagerClient } from '@scribear/session-manager-client';
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
  selectShowJoinCode,
} from '#src/features/cross-screen/stores/display-settings-slice';
import {
  selectActiveSessionId,
  selectDeviceName,
} from '#src/features/room-provider/stores/room-config-slice';
import {
  selectJoinCode,
  selectUpcomingSessions,
  setJoinCode,
} from '#src/features/room-provider/stores/room-service-slice';
import { useAppDispatch, useAppSelector } from '#src/store/use-redux';
import { buildClientJoinUrl } from '#src/utils/client-join-url';

export const DisplayLive = () => {
  const dispatch = useAppDispatch();
  const deviceName = useAppSelector(selectDeviceName);
  const activeSessionId = useAppSelector(selectActiveSessionId);
  const joinCode = useAppSelector(selectJoinCode);
  const showJoinCode = useAppSelector(selectShowJoinCode);
  const upcomingSessions = useAppSelector(selectUpcomingSessions);
  const activeSession = activeSessionId
    ? (upcomingSessions.find((s) => s.sessionId === activeSessionId) ?? null)
    : null;

  // fontSize is controlled by the touchscreen via BroadcastChannel / displaySettings
  const fontSize = useAppSelector(selectFontSize);

  // Transcription content
  const commitedSections = useAppSelector(selectCommitedSections);
  const activeSection = useAppSelector(selectActiveSection);
  const inProgressTranscriptionText = useAppSelector(
    selectInProgressTranscriptionText,
  );

  // Display layout prefs — lineHeight multiplier comes from the user's
  // transcription-display preferences; we apply it to the touchscreen-controlled fontSize.
  const lineHeightMultipler = useAppSelector(selectLineHeightMultipler);
  const wordSpacingEm = useAppSelector(selectWordSpacingEm);
  const targetVerticalPositionPx = useAppSelector(
    selectTargetVerticalPositionPx,
  );
  const targetDisplayLines = useAppSelector(selectTargetDisplayLines);

  const lineHeightPx = Math.round(fontSize * lineHeightMultipler);
  useEffect(() => {
    if (!showJoinCode || !activeSessionId) {
      return;
    }

    const sessionManagerClient = createSessionManagerClient(
      window.location.origin,
    );
    let cancelled = false;

    const fetchJoinCode = async () => {
      const [response, error] = await sessionManagerClient.getSessionJoinCode({
        params: { sessionId: activeSessionId },
      });

      if (cancelled) return;

      if (error || response.status !== 200) {
        return;
      }

      dispatch(
        setJoinCode({
          joinCode: response.data.joinCode,
          expiresAtUnixMs: response.data.expiresAtUnixMs,
        }),
      );
    };

    void fetchJoinCode();

    return () => {
      cancelled = true;
    };
  }, [activeSessionId, dispatch, showJoinCode]);

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
        <Typography variant="h6" fontWeight="bold">
          {deviceName ?? 'Room Display'}
        </Typography>
        <Stack direction="row" alignItems="center" spacing={2}>
          {activeSession?.endTime != null && (
            <Typography variant="body2" color="text.secondary">
              Session in progress · ends at{' '}
              <Box component="span" sx={{ color: '#ffffff', fontWeight: 700 }}>
                {new Date(activeSession.endTime).toLocaleTimeString([], {
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </Box>
            </Typography>
          )}
          <Chip
            label="● LIVE"
            color="error"
            variant="filled"
            size="small"
            sx={{ fontWeight: 700, letterSpacing: 1 }}
          />
        </Stack>
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
              width: 240,
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
            <Typography
              variant="caption"
              color="text.secondary"
              textAlign="center"
            >
              Join with code
            </Typography>
            <Typography variant="h5" fontFamily="monospace" letterSpacing={3}>
              {joinCode}
            </Typography>
            <Box sx={{ p: 1, bgcolor: '#ffffff', borderRadius: 1 }}>
              <QRCodeSVG
                value={buildClientJoinUrl(joinCode)}
                size={180}
                bgColor="#ffffff"
                fgColor="#000000"
                marginSize={4}
                level="L"
              />
            </Box>
          </Box>
        )}
      </Box>
    </Box>
  );
};
