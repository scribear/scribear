import { useCallback } from 'react';

import Box from '@mui/material/Box';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

import {
  selectIsHeaderHideEnabled,
  toggleHeaderHide,
} from '@scribear/app-layout-store';
import { AppLayout } from '@scribear/core-ui';
import {
  selectAccentColor,
  selectBackgroundColor,
  selectTranscriptionColor,
  setAccentColor,
  setBackgroundColor,
  setTheme,
  setTranscriptionColor,
} from '@scribear/theme-customization-store';
import { ThemeCustomizationMenu } from '@scribear/theme-customization-ui';
import {
  selectActiveSection,
  selectCommitedSections,
  selectInProgressTranscriptionText,
} from '@scribear/transcription-content-store';
import {
  resetTranscriptionDisplayPreferences,
  selectBoundedDisplayPreferences,
  selectFontSizePx,
  selectLineHeightMultipler,
  selectLineHeightPx,
  selectNumDisplayLinesBounds,
  selectVerticalPositionBoundsPx,
  selectWordSpacingEm,
  setFontSizePx,
  setLineHeightMultipler,
  setTargetDisplayLines,
  setTargetVerticalPositionPx,
  setWordSpacingEm,
} from '@scribear/transcription-display-store';
import {
  TranscriptionDisplayContainer,
  TranscriptionDisplayPreferencesMenu,
} from '@scribear/transcription-display-ui';

import { JoinCodeQrCode } from '#src/features/kiosk-provider/components/join-code-qr-code';
import { selectJoinCode } from '#src/features/kiosk-provider/stores/kiosk-service-slice';
import { selectIsPaused } from '#src/features/session-controls/stores/session-controls-slice';
import { useAppDispatch, useAppSelector } from '#src/store/use-redux';

/**
 * Audience-facing display: mirrors host transcription via BroadcastChannel.
 * Shell matches audience-display (`AppLayout` + preference drawers); join code
 * and QR come from synced kiosk state instead of a manual session connect UI.
 */
export const DisplayRoot = () => {
  const dispatch = useAppDispatch();
  const isHeaderHideEnabled = useAppSelector(selectIsHeaderHideEnabled);

  const backgroundColor = useAppSelector(selectBackgroundColor);
  const accentColor = useAppSelector(selectAccentColor);
  const transcriptionColor = useAppSelector(selectTranscriptionColor);

  const commitedSections = useAppSelector(selectCommitedSections);
  const activeSection = useAppSelector(selectActiveSection);
  const inProgressTranscriptionText = useAppSelector(
    selectInProgressTranscriptionText,
  );

  const fontSizePx = useAppSelector(selectFontSizePx);
  const lineHeightPx = useAppSelector(selectLineHeightPx);
  const lineHeightMultipler = useAppSelector(selectLineHeightMultipler);
  const wordSpacingEm = useAppSelector(selectWordSpacingEm);
  const transcriptionDisplayPreferences = useAppSelector(
    (state) => state.transcriptionDisplayPreferences,
  );

  const joinCode = useAppSelector(selectJoinCode);
  const isPaused = useAppSelector(selectIsPaused);

  const getBoundedDisplayPreferences = useCallback(
    (containerHeightPx: number) =>
      selectBoundedDisplayPreferences(
        { transcriptionDisplayPreferences },
        { containerHeightPx },
      ),
    [transcriptionDisplayPreferences],
  );
  const getVerticalPositionBoundsPx = useCallback(
    (containerHeightPx: number) =>
      selectVerticalPositionBoundsPx(
        { transcriptionDisplayPreferences },
        { containerHeightPx },
      ),
    [transcriptionDisplayPreferences],
  );
  const getNumDisplayLinesBounds = useCallback(
    (containerHeightPx: number) =>
      selectNumDisplayLinesBounds(
        { transcriptionDisplayPreferences },
        { containerHeightPx },
      ),
    [transcriptionDisplayPreferences],
  );

  const DrawerMenus = (
    <>
      <ThemeCustomizationMenu
        backgroundColor={backgroundColor}
        accentColor={accentColor}
        transcriptionColor={transcriptionColor}
        setBackgroundColor={(v) => dispatch(setBackgroundColor(v))}
        setAccentColor={(v) => dispatch(setAccentColor(v))}
        setTranscriptionColor={(v) => dispatch(setTranscriptionColor(v))}
        applyPresetTheme={(theme) => dispatch(setTheme(theme))}
      />
      <TranscriptionDisplayPreferencesMenu
        fontSizePx={fontSizePx}
        lineHeightMultipler={lineHeightMultipler}
        wordSpacingEm={wordSpacingEm}
        setFontSizePx={(v) => dispatch(setFontSizePx(v))}
        setLineHeightMultipler={(v) => dispatch(setLineHeightMultipler(v))}
        setWordSpacingEm={(v) => dispatch(setWordSpacingEm(v))}
        setTargetVerticalPositionPx={(v) =>
          dispatch(setTargetVerticalPositionPx(v))
        }
        setTargetDisplayLines={(v) => dispatch(setTargetDisplayLines(v))}
        resetPreferences={() =>
          dispatch(resetTranscriptionDisplayPreferences())
        }
        getBoundedDisplayPreferences={getBoundedDisplayPreferences}
        getVerticalPositionBoundsPx={getVerticalPositionBoundsPx}
        getNumDisplayLinesBounds={getNumDisplayLinesBounds}
      />
    </>
  );

  return (
    <AppLayout
      isHeaderHideEnabled={isHeaderHideEnabled}
      onToggleHeaderHide={() => dispatch(toggleHeaderHide())}
      drawerContent={DrawerMenus}
      headerButtons={[]}
      headerBreakpoint="md"
    >
      <Box
        sx={{
          display: 'grid',
          gridTemplateRows: '1fr auto',
          height: '100%',
          minHeight: 0,
        }}
      >
        <Box sx={{ minHeight: 0, position: 'relative', p: 1 }}>
          <TranscriptionDisplayContainer
            commitedSections={commitedSections}
            activeSection={activeSection}
            inProgressTranscriptionText={inProgressTranscriptionText}
            wordSpacingEm={wordSpacingEm}
            fontSizePx={fontSizePx}
            lineHeightPx={lineHeightPx}
            getBoundedDisplayPreferences={getBoundedDisplayPreferences}
          />
          {isPaused ? (
            <Paper
              sx={{
                position: 'absolute',
                top: 16,
                right: 16,
                px: 2,
                py: 1,
              }}
            >
              <Typography variant="h6">Session Paused</Typography>
            </Paper>
          ) : null}
        </Box>
        <Stack sx={{ pt: 2, pb: 2 }} alignItems="center">
          {joinCode ? (
            <>
              <Typography variant="h5" fontFamily="monospace">
                Join Code: {joinCode}
              </Typography>
              <JoinCodeQrCode joinCode={joinCode} />
            </>
          ) : (
            <Typography variant="h6">Waiting for active session</Typography>
          )}
        </Stack>
      </Box>
    </AppLayout>
  );
};
