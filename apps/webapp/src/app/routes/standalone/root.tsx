/**
 * Root of standalone mode
 */
import Stack from '@mui/material/Stack';

import { AppLayout } from '@/components/app-layout';
import { MicrophoneModal } from '@/core/microphone/components/microphone-modal';
import { ToggleMicrophoneButton } from '@/core/microphone/components/toggle-microphone-button';
import { ThemeCustomizationMenu } from '@/features/theme-customization/components/theme-customization-menu';
import { TranscriptionDisplayContainer } from '@/features/transcription-display/components/transcription-display-container';
import { TranscriptionDisplayPreferencesMenu } from '@/features/transcription-display/components/transcription-display-preferences-menu';
import { TranscriptionProviderStatusModal } from '@/features/transcription-providers/components/transcription-provider-status-modal';
import { TranscriptionProviderSelector } from '@/features/transcription-providers/components/transcription-provider-selector';
import { TranscriptionProviderStatusDisplay } from '@/features/transcription-providers/components/transcription-provider-status-display';

const StandaloneRoot = () => {
  const DrawerMenus = (
    <>
      <ThemeCustomizationMenu />
      <TranscriptionDisplayPreferencesMenu />
    </>
  );

  const HeaderButtons = [
    <ToggleMicrophoneButton key="mic" />,
  ];

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
