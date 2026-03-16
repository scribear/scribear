/**
 * Root of standalone mode
 */
import Stack from '@mui/material/Stack';

import { AppLayout } from '#src/components/app-layout';
import { MicrophoneModal } from '#src/core/microphone/components/microphone-modal';
import { ToggleMicrophoneButton } from '#src/core/microphone/components/toggle-microphone-button';
import { ThemeCustomizationMenu } from '#src/features/theme-customization/components/theme-customization-menu';
import { TranscriptionDisplayContainer } from '#src/features/transcription-display/components/transcription-display-container';
import { TranscriptionDisplayPreferencesMenu } from '#src/features/transcription-display/components/transcription-display-preferences-menu';
import { TranscriptionProviderSelector } from '#src/features/transcription-providers/components/transcription-provider-selector';
import { TranscriptionProviderStatusDisplay } from '#src/features/transcription-providers/components/transcription-provider-status-display';
import { TranscriptionProviderStatusModal } from '#src/features/transcription-providers/components/transcription-provider-status-modal';
import { ProviderId } from '#src/features/transcription-providers/services/providers/provider-registry';
import { selectTargetProviderId } from '#src/features/transcription-providers/stores/provider-preferences-slice';
import { useAppSelector } from '#src/stores/use-redux';

const StandaloneRoot = () => {
  const targetProviderId = useAppSelector(selectTargetProviderId);

  const DrawerMenus = (
    <>
      <ThemeCustomizationMenu />
      <TranscriptionDisplayPreferencesMenu />
    </>
  );

  const HeaderButtons =
    targetProviderId === ProviderId.STREAMTEXT
      ? []
      : [<ToggleMicrophoneButton key="mic" />];

  const ProviderSelector = (
    <Stack direction="row" alignItems="center">
      <TranscriptionProviderStatusDisplay />
      <TranscriptionProviderSelector />
    </Stack>
  );

  return (
    <AppLayout
      drawerContent={DrawerMenus}
      headerButtons={HeaderButtons}
      providerSelector={ProviderSelector}
      headerBreakpoint="md"
    >
      <MicrophoneModal />
      <TranscriptionProviderStatusModal />
      <TranscriptionDisplayContainer />
    </AppLayout>
  );
};

export default StandaloneRoot;
