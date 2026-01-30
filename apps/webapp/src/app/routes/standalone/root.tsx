/**
 * Root of standalone mode
 */
import { AppLayout } from '@/components/app-layout';
import { MicrophoneModal } from '@/core/microphone/components/microphone-modal';
import { ToggleMicrophoneButton } from '@/core/microphone/components/toggle-microphone-button';

const StandaloneRoot = () => {
  const DrawerMenus = <>Drawer</>;

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
    </AppLayout>
  );
};

export default StandaloneRoot;
