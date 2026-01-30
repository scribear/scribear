/**
 * Root of standalone mode
 */
import { AppLayout } from '@/components/app-layout';
import { MicrophoneModal } from '@/core/microphone/components/microphone-modal';
import { ToggleMicrophoneButton } from '@/core/microphone/components/toggle-microphone-button';
import { TranscriptionDisplayContainer } from '@/features/transcription-display/components/transcription-display-container';
import { TranscriptionDisplayPreferencesMenu } from '@/features/transcription-display/components/transcription-display-preferences-menu';

const StandaloneRoot = () => {
  const DrawerMenus = (
    <>
      <TranscriptionDisplayPreferencesMenu />
    </>
  );

  const HeaderButtons = [<ToggleMicrophoneButton key="mic" />];

  const ProviderSelector = <>Web Speech</>;

  return (
    <AppLayout
      drawerContent={DrawerMenus}
      headerButtons={HeaderButtons}
      providerSelector={ProviderSelector}
      headerBreakpoint="md"
    >
      <MicrophoneModal />
      <TranscriptionDisplayContainer />
    </AppLayout>
  );
};

export default StandaloneRoot;
