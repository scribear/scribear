import { useCallback } from 'react';

import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';

import {
  selectIsHeaderHideEnabled,
  toggleHeaderHide,
} from '@scribear/app-layout-store';
import { AppLayout } from '@scribear/core-ui';
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

  const ProviderSelector = <Stack direction="row" alignItems="center"></Stack>;

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
