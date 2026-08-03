import { useCallback } from 'react';

import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';

import {
  selectIsHeaderHideEnabled,
  toggleHeaderHide,
} from '@scribear/app-layout-store';
import { AppLayout, ConnectionStatusBanner } from '@scribear/core-ui';
import {
  disableTranslation,
  enableTranslation,
  languageDisplayName,
  selectActiveTargetLanguage,
  selectAvailableTranslationLanguages,
  selectIsTranslationEnabled,
  selectIsTranslationRunning,
  selectIsTranslationSupported,
  selectTargetLanguage,
  selectTranslatedSegments,
  selectTranslationDownloadProgress,
  selectTranslationErrorMessage,
  selectTranslationStatus,
  setTargetLanguage,
} from '@scribear/live-translation-store';
import {
  LiveTranslationMenu,
  TranslatedCaptionsPanel,
} from '@scribear/live-translation-ui';
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

  // Translated captions. Every selector here reads `UNSUPPORTED` on a browser
  // without the Translator API, which is what removes the menu and the panel.
  const isTranslationSupported = useAppSelector(selectIsTranslationSupported);
  const isTranslationEnabled = useAppSelector(selectIsTranslationEnabled);
  const isTranslationRunning = useAppSelector(selectIsTranslationRunning);
  const preferredTargetLanguage = useAppSelector(selectTargetLanguage);
  const activeTargetLanguage = useAppSelector(selectActiveTargetLanguage);
  const availableLanguages = useAppSelector(
    selectAvailableTranslationLanguages,
  );
  const translatedSegments = useAppSelector(selectTranslatedSegments);
  const translationStatus = useAppSelector(selectTranslationStatus);
  const translationDownloadProgress = useAppSelector(
    selectTranslationDownloadProgress,
  );
  const translationErrorMessage = useAppSelector(selectTranslationErrorMessage);

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
      <LiveTranslationMenu
        isSupported={isTranslationSupported}
        isEnabled={isTranslationEnabled}
        targetLanguage={preferredTargetLanguage}
        languages={availableLanguages}
        // Dispatched straight from the confirm click so the browser still sees
        // user activation when `create()` starts a model download.
        onEnable={(language) => dispatch(enableTranslation(language))}
        onDisable={() => dispatch(disableTranslation())}
        onChangeLanguage={(language) => dispatch(setTargetLanguage(language))}
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
          // One caption column split between original and translated text,
          // rather than each claiming the full viewport height.
          <Box
            sx={{ height: '100dvh', display: 'flex', flexDirection: 'column' }}
          >
            <Box sx={{ flex: '1 1 auto', minHeight: 0 }}>
              <TranscriptionDisplayContainer
                commitedSections={commitedSections}
                activeSection={activeSection}
                inProgressTranscriptionText={inProgressTranscriptionText}
                wordSpacingEm={wordSpacingEm}
                fontSizePx={fontSizePx}
                lineHeightPx={lineHeightPx}
                getBoundedDisplayPreferences={getBoundedDisplayPreferences}
                fillParentHeight
                // When translation is on, the translated panel is the region
                // the reader chose to follow and the one that announces. Two
                // live regions carrying the same speech announce it twice and
                // make both unusable.
                announceUpdates={!isTranslationRunning}
              />
            </Box>
            {isTranslationRunning && (
              <Box sx={{ flex: '0 0 auto' }}>
                <TranslatedCaptionsPanel
                  segments={translatedSegments}
                  status={translationStatus}
                  targetLanguage={activeTargetLanguage}
                  targetLanguageLabel={languageDisplayName(
                    activeTargetLanguage,
                  )}
                  downloadProgress={translationDownloadProgress}
                  errorMessage={translationErrorMessage}
                  wordSpacingEm={wordSpacingEm}
                  fontSizePx={fontSizePx}
                  lineHeightPx={lineHeightPx}
                />
              </Box>
            )}
          </Box>
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
