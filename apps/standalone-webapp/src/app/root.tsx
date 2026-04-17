import { useCallback } from 'react';

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

import { VisualizerContainer } from '#src/features/visualizer/components/visualizer-container';
import { VisualizerSettingsMenu } from '#src/features/visualizer/components/visualizer-settings-menu';
import { SwitchingProviderModal } from '#src/features/transcription-providers/components/switching-provider-modal';
import { TranscriptionProviderConfigMenu } from '#src/features/transcription-providers/components/transcription-provider-config-menu';
import { TranscriptionProviderSelector } from '#src/features/transcription-providers/components/transcription-provider-selector';
import { TranscriptionProviderStatusDisplay } from '#src/features/transcription-providers/components/transcription-provider-status-display';
import { TranscriptionProviderStatusModal } from '#src/features/transcription-providers/components/transcription-provider-status-modal';
import { useAppDispatch, useAppSelector } from '#src/store/use-redux';

/**
 * Root layout component for the standalone webapp. Renders the full application
 * shell including the header, drawer menus, microphone controls, provider selector,
 * status modals, and transcription display.
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
      <VisualizerSettingsMenu />
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
    <Stack direction="row" alignItems="center">
      <TranscriptionProviderStatusDisplay />
      <TranscriptionProviderSelector />
    </Stack>
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
      <VisualizerContainer />
      <MicrophoneModal
        microphoneServiceStatus={microphoneServiceStatus}
        activate={() => void dispatch(activateMicrophone())}
        deactivate={() => dispatch(deactivateMicrophone())}
      />
      <TranscriptionProviderStatusModal />
      <TranscriptionProviderConfigMenu />
      <SwitchingProviderModal />
      <TranscriptionDisplayContainer
        commitedSections={commitedSections}
        activeSection={activeSection}
        inProgressTranscriptionText={inProgressTranscriptionText}
        wordSpacingEm={wordSpacingEm}
        fontSizePx={fontSizePx}
        lineHeightPx={lineHeightPx}
        getBoundedDisplayPreferences={getBoundedDisplayPreferences}
      />
    </AppLayout>
  );
};
