import { useCallback } from 'react';

import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';

import {
  selectIsHeaderHideEnabled,
  toggleHeaderHide,
} from '@scribear/app-layout-store';
import { AppLayout, ConnectionStatusBanner } from '@scribear/core-ui';
import {
  activateMicrophone,
  deactivateMicrophone,
  selectIsMicrophoneServiceActive,
  selectMicrophoneServiceStatus,
} from '@scribear/microphone-store';
import {
  MicrophoneModal,
  ToggleMicrophoneButton,
} from '@scribear/microphone-ui';
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

import { KioskStatusPanel } from '#src/features/kiosk-provider/components/kiosk-status-panel';
import { selectConnectionBanner } from '#src/features/kiosk-provider/stores/kiosk-slice';
import { KioskSplitLayout } from '#src/features/kiosk-split-screen/components/kiosk-split-layout';
import { useAppDispatch, useAppSelector } from '#src/store/use-redux';

/**
 * Top-level page layout for the kiosk webapp. Renders a split-screen view with
 * the transcription display on the left and the kiosk status panel on the right,
 * together with a microphone toggle button and settings drawer menus.
 */
export const Root = () => {
  const dispatch = useAppDispatch();
  const isHeaderHideEnabled = useAppSelector(selectIsHeaderHideEnabled);

  // Connection status - surfaces the kiosk's own socket to node-server, and
  // node-server's upstream link to the transcription service, dropping.
  // Public-facing display: if this goes silently unindicated the audience
  // reading captions has no way to know why they've stopped.
  const connectionBanner = useAppSelector(selectConnectionBanner);

  // Theme
  const backgroundColor = useAppSelector(selectBackgroundColor);
  const accentColor = useAppSelector(selectAccentColor);
  const transcriptionColor = useAppSelector(selectTranscriptionColor);

  // Microphone
  const isMicrophoneActive = useAppSelector(selectIsMicrophoneServiceActive);
  const microphoneServiceStatus = useAppSelector(selectMicrophoneServiceStatus);

  // Transcription content
  const commitedSections = useAppSelector(selectCommitedSections);
  const activeSection = useAppSelector(selectActiveSection);
  const inProgressTranscriptionText = useAppSelector(
    selectInProgressTranscriptionText,
  );

  // Display prefs
  const fontSizePx = useAppSelector(selectFontSizePx);
  const lineHeightPx = useAppSelector(selectLineHeightPx);
  const lineHeightMultipler = useAppSelector(selectLineHeightMultipler);
  const wordSpacingEm = useAppSelector(selectWordSpacingEm);
  const transcriptionDisplayPreferences = useAppSelector(
    (state) => state.transcriptionDisplayPreferences,
  );

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

  const HeaderButtons = [
    <ToggleMicrophoneButton
      key="mic"
      isMicrophoneActive={isMicrophoneActive}
      activate={() => void dispatch(activateMicrophone())}
      deactivate={() => dispatch(deactivateMicrophone())}
    />,
  ];

  const ProviderSelector = (
    <Stack
      direction="row"
      sx={{
        alignItems: 'center',
      }}
    ></Stack>
  );

  return (
    <AppLayout
      isHeaderHideEnabled={isHeaderHideEnabled}
      onToggleHeaderHide={() => dispatch(toggleHeaderHide())}
      drawerContent={DrawerMenus}
      headerButtons={HeaderButtons}
      providerSelector={ProviderSelector}
      headerBreakpoint="md"
    >
      <MicrophoneModal
        microphoneServiceStatus={microphoneServiceStatus}
        activate={() => void dispatch(activateMicrophone())}
        deactivate={() => dispatch(deactivateMicrophone())}
      />
      {/* Mounted once at the top level, as a full-width bar fixed to the
          viewport bottom, so it's visible regardless of which side of the
          split (transcription display vs. status panel) the underlying
          problem relates to. Its high z-index intentionally takes priority
          over the transcription pane's JumpToBottomButton, which can sit at
          the same visual bottom edge - during the connection problems this
          banner reports, no new transcript content is arriving anyway, so
          "jump to latest" has nothing new to jump to. */}
      <ConnectionStatusBanner
        open={connectionBanner.open}
        severity={connectionBanner.open ? connectionBanner.severity : 'warning'}
        message={connectionBanner.open ? connectionBanner.message : ''}
      />
      <KioskSplitLayout
        left={
          <TranscriptionDisplayContainer
            commitedSections={commitedSections}
            activeSection={activeSection}
            inProgressTranscriptionText={inProgressTranscriptionText}
            wordSpacingEm={wordSpacingEm}
            fontSizePx={fontSizePx}
            lineHeightPx={lineHeightPx}
            getBoundedDisplayPreferences={getBoundedDisplayPreferences}
          />
        }
        right={
          <Box sx={{ height: '100%' }}>
            <KioskStatusPanel />
          </Box>
        }
      />
    </AppLayout>
  );
};
