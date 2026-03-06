/**
 * Root of kiosk mode
 */
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';

import { AppLayout } from '#src/components/app-layout';
import { MicrophoneModal } from '#src/core/microphone/components/microphone-modal';
import { ToggleMicrophoneButton } from '#src/core/microphone/components/toggle-microphone-button';
import { KioskSplitLayout } from '#src/features/kiosk-split-screen/components/kiosk-split-layout';
import { ThemeCustomizationMenu } from '#src/features/theme-customization/components/theme-customization-menu';
import { TranscriptionDisplayContainer } from '#src/features/transcription-display/components/transcription-display-container.js';
import { TranscriptionDisplayPreferencesMenu } from '#src/features/transcription-display/components/transcription-display-preferences-menu';

const KioskRoot = () => {
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
      <KioskSplitLayout
        left={<TranscriptionDisplayContainer />}
        right={
          <Box bgcolor={'background.main'} sx={{ height: '100%' }}>
            Test
          </Box>
        }
      />
    </AppLayout>
  );
};

export default KioskRoot;
