import {
  selectIsTranslationSupported,
  selectTranslationCallLatency,
  selectTranslationDroppedCaptions,
  selectTranslationQueuedCaptions,
  selectTranslationSampleCount,
  selectTranslationStatus,
  selectTranslationTotalLatency,
  selectTranslationWaitLatency,
} from '@scribear/live-translation-store';
import {
  LatencyMetricsCard,
  MetricsOverlay,
  TranslationMetricsCard,
  useMetricsOverlay,
} from '@scribear/metrics-overlay-ui';
import {
  selectFinalE2eLatencyMs,
  selectFinalPipelineLatencyMs,
  selectInProgressE2eLatencyMs,
  selectInProgressPipelineLatencyMs,
} from '@scribear/transcription-content-store';

import { useAppSelector } from '#src/store/use-redux';

/**
 * Wires this app's store to the diagnostic overlays.
 *
 * Which cards appear is decided by {@link useMetricsOverlay}: the `#metrics=`
 * fragment on load, toggled by `m`. Nothing renders unless one was asked for,
 * so a reader never pays for the selectors' work.
 */
export const MetricsOverlayContainer = () => {
  const visibleMetrics = useMetricsOverlay();

  const pipelineFinalMs = useAppSelector(selectFinalPipelineLatencyMs);
  const pipelineInterimMs = useAppSelector(selectInProgressPipelineLatencyMs);
  const e2eFinalMs = useAppSelector(selectFinalE2eLatencyMs);
  const e2eInterimMs = useAppSelector(selectInProgressE2eLatencyMs);

  // No Translator API here - the whole feature is hidden, so its metrics would
  // be noise rather than diagnosis.
  const isTranslationSupported = useAppSelector(selectIsTranslationSupported);
  const translationStatus = useAppSelector(selectTranslationStatus);
  const wait = useAppSelector(selectTranslationWaitLatency);
  const translate = useAppSelector(selectTranslationCallLatency);
  const total = useAppSelector(selectTranslationTotalLatency);
  const queuedCaptions = useAppSelector(selectTranslationQueuedCaptions);
  const droppedCaptions = useAppSelector(selectTranslationDroppedCaptions);
  const sampleCount = useAppSelector(selectTranslationSampleCount);

  if (visibleMetrics.size === 0) return null;

  return (
    <MetricsOverlay>
      {visibleMetrics.has('latency') && (
        <LatencyMetricsCard
          pipelineFinalMs={pipelineFinalMs}
          pipelineInterimMs={pipelineInterimMs}
          e2eFinalMs={e2eFinalMs}
          e2eInterimMs={e2eInterimMs}
        />
      )}
      {visibleMetrics.has('translation') && isTranslationSupported && (
        <TranslationMetricsCard
          statusLabel={translationStatus.toLowerCase()}
          wait={wait}
          translate={translate}
          total={total}
          queuedCaptions={queuedCaptions}
          droppedCaptions={droppedCaptions}
          sampleCount={sampleCount}
        />
      )}
    </MetricsOverlay>
  );
};
