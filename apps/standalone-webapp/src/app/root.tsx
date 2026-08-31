import { useCallback } from 'react';

import ClearAllIcon from '@mui/icons-material/ClearAll';
import IconButton from '@mui/material/IconButton';
import Stack from '@mui/material/Stack';
import Tooltip from '@mui/material/Tooltip';

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
  clearTranscription,
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

import { SwitchingProviderModal } from '#src/features/transcription-providers/components/switching-provider-modal';
import { TranscriptionProviderConfigMenu } from '#src/features/transcription-providers/components/transcription-provider-config-menu';
import { TranscriptionProviderSelector } from '#src/features/transcription-providers/components/transcription-provider-selector';
import { TranscriptionProviderStatusDisplay } from '#src/features/transcription-providers/components/transcription-provider-status-display';
import { TranscriptionProviderStatusModal } from '#src/features/transcription-providers/components/transcription-provider-status-modal';
import { VisualizerContainer } from '#src/features/visualizer/components/visualizer-container';
import { VisualizerSettingsMenu } from '#src/features/visualizer/components/visualizer-settings-menu';
import { useAppDispatch, useAppSelector } from '#src/store/use-redux';

/**
 * How long the caption region may sit scrolled back with no scrolling and no
 * sign of a reader before it returns to following the speaker.
 *
 * Standalone runs on the speaker's own machine with no session behind it, so
 * the transcript on screen is the only copy of what was said - which cuts both
 * ways. Silently stopping following means the tail of the talk scrolls past
 * unread, and nobody is watching the window closely enough to notice, because
 * the machine is usually mid-presentation and doing something else. Three
 * minutes without a scroll, a key or a pointer move on a laptop that is
 * physically in front of someone reads as "not reading right now", and any
 * real interaction resets the clock.
 */
const IDLE_REENGAGE_MS = 180_000;

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
    <Tooltip key="clear" title="Clear Transcription">
      <IconButton
        color="inherit"
        onClick={() => dispatch(clearTranscription())}
      >
        <ClearAllIcon />
      </IconButton>
    </Tooltip>,
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
    >
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
        idleReengageMs={IDLE_REENGAGE_MS}
      />
    </AppLayout>
  );
};
