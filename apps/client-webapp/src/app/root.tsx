import { useCallback } from 'react';

import Box from '@mui/material/Box';

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
  cancelSummary,
  dismissExportError,
  downloadLastSummary,
  downloadTranscript,
  requestSummary,
  selectExportErrorMessage,
  selectHasCompletedSummaryRun,
  selectIsSummarizationOffered,
  selectIsSummarizing,
  selectLastSummary,
  selectSummarizationProgress,
  selectSummarizerDownloadProgress,
  selectSummarizerNeedsDownload,
} from '@scribear/transcript-export-store';
import { TranscriptExportMenu } from '@scribear/transcript-export-ui';
import {
  selectActiveSection,
  selectCommitedSections,
  selectInProgressTranscriptionText,
  selectTranscriptWordCount,
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

import { JoinSessionModal } from '#src/features/session-provider/components/join-session-modal';
import { LatencyBadge } from '#src/features/session-provider/components/latency-badge';
import { LeaveSessionButton } from '#src/features/session-provider/components/leave-session-button';
import { selectConnectionBanner } from '#src/features/session-provider/stores/derive-connection-banner';
import { useAppDispatch, useAppSelector } from '#src/store/use-redux';

/**
 * Top-level page layout for the client webapp. Renders the transcription display
 * inside an `AppLayout` with theme and display-preference drawer menus.
 */
export const Root = () => {
  const dispatch = useAppDispatch();
  const isHeaderHideEnabled = useAppSelector(selectIsHeaderHideEnabled);
  const connectionBanner = useAppSelector(selectConnectionBanner);

  // Theme
  const backgroundColor = useAppSelector(selectBackgroundColor);
  const accentColor = useAppSelector(selectAccentColor);
  const transcriptionColor = useAppSelector(selectTranscriptionColor);

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

  // Saving the transcript, and an on-device summary of it. Like translation,
  // every summary control disappears when the browser cannot run the model.
  const transcriptWordCount = useAppSelector(selectTranscriptWordCount);
  const isSummarizationOffered = useAppSelector(selectIsSummarizationOffered);
  const summarizerNeedsDownload = useAppSelector(selectSummarizerNeedsDownload);
  const hasCompletedSummaryRun = useAppSelector(selectHasCompletedSummaryRun);
  const isSummarizing = useAppSelector(selectIsSummarizing);
  const summarizationProgress = useAppSelector(selectSummarizationProgress);
  const summarizerDownloadProgress = useAppSelector(
    selectSummarizerDownloadProgress,
  );
  const lastSummary = useAppSelector(selectLastSummary);
  const exportErrorMessage = useAppSelector(selectExportErrorMessage);

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
      <TranscriptExportMenu
        transcriptWordCount={transcriptWordCount}
        isSummarizationOffered={isSummarizationOffered}
        needsModelDownload={summarizerNeedsDownload}
        hasCompletedRun={hasCompletedSummaryRun}
        isSummarizing={isSummarizing}
        progress={summarizationProgress}
        downloadProgress={summarizerDownloadProgress}
        hasSavedSummary={lastSummary !== null}
        errorMessage={exportErrorMessage}
        onDownloadTranscript={() => dispatch(downloadTranscript())}
        // Dispatched straight from the confirm click, so the browser still
        // sees user activation when create() starts the model download.
        onRequestSummary={() => dispatch(requestSummary())}
        onDownloadLastSummary={() => dispatch(downloadLastSummary())}
        onCancelSummary={() => dispatch(cancelSummary())}
        onDismissError={() => dispatch(dismissExportError())}
      />
    </>
  );

  return (
    <AppLayout
      isHeaderHideEnabled={isHeaderHideEnabled}
      onToggleHeaderHide={() => dispatch(toggleHeaderHide())}
      drawerContent={DrawerMenus}
      headerButtons={[<LeaveSessionButton key="leave" />]}
      headerBreakpoint="md"
    >
      <JoinSessionModal />
      <LatencyBadge />
      <ConnectionStatusBanner
        open={connectionBanner.open}
        severity={connectionBanner.open ? connectionBanner.severity : 'warning'}
        message={connectionBanner.open ? connectionBanner.message : ''}
      />
      {/* One viewport split between original and translated captions, rather
          than each claiming 100dvh and pushing the other off screen. */}
      <Box sx={{ height: '100dvh', display: 'flex', flexDirection: 'column' }}>
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
            // When translation is on, the translated panel is the region the
            // reader chose to follow and the one that announces. Two live
            // regions carrying the same speech announce it twice and make
            // both unusable.
            announceUpdates={!isTranslationRunning}
          />
        </Box>
        {isTranslationRunning && (
          <Box sx={{ flex: '0 0 auto' }}>
            <TranslatedCaptionsPanel
              segments={translatedSegments}
              status={translationStatus}
              targetLanguage={activeTargetLanguage}
              targetLanguageLabel={languageDisplayName(activeTargetLanguage)}
              downloadProgress={translationDownloadProgress}
              errorMessage={translationErrorMessage}
              wordSpacingEm={wordSpacingEm}
              fontSizePx={fontSizePx}
              lineHeightPx={lineHeightPx}
            />
          </Box>
        )}
      </Box>
    </AppLayout>
  );
};
