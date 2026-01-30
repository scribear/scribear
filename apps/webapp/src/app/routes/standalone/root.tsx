import DownloadIcon from '@mui/icons-material/Download';
import MicIcon from '@mui/icons-material/Mic';
import IconButton from '@mui/material/IconButton';

import { AppLayout } from '@/components/app-layout';

/**
 * Root of standalone mode
 */
const StandaloneRoot = () => {
  return (
    <AppLayout
      providerSelector={'Web Speech'}
      headerButtons={[
        <IconButton color="inherit">
          <MicIcon />
        </IconButton>,
        <IconButton color="inherit">
          <DownloadIcon />
        </IconButton>,
      ]}
      drawerContent={'Drawer'}
      headerBreakpoint="md"
    >
      Content
    </AppLayout>
  );
};

export default StandaloneRoot;
