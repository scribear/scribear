/**
 * Root of client mode
 */
import Stack from '@mui/material/Stack';

import { AppLayout } from '#src/components/app-layout';
import { MicrophoneModal } from '#src/core/microphone/components/microphone-modal';
import { ToggleMicrophoneButton } from '#src/core/microphone/components/toggle-microphone-button';
import { ThemeCustomizationMenu } from '#src/features/theme-customization/components/theme-customization-menu';
import { TranscriptionDisplayPreferencesMenu } from '#src/features/transcription-display/components/transcription-display-preferences-menu';

const ClientRoot = () => {
  const DrawerMenus = (
    <>
      <ThemeCustomizationMenu />
      <TranscriptionDisplayPreferencesMenu />
    </>
  );

  const HeaderButtons = [<ToggleMicrophoneButton key="mic" />];

  const ProviderSelector = <Stack direction="row" alignItems="center"></Stack>;

  return (
    <AppLayout
      drawerContent={DrawerMenus}
      headerButtons={HeaderButtons}
      providerSelector={ProviderSelector}
      headerBreakpoint="md"
    >
      <MicrophoneModal />
    </AppLayout>
  );
};

export default ClientRoot;
