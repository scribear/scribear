import Box from '@mui/material/Box';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';

import { AppLink } from '#src/components/ui/app-link';
import { PATHS } from '#src/config/paths';

/**
 * Root of landing page
 */
const LandingRoute = () => {
  return (
    <Box
      sx={{
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        flexDirection: 'column',
        height: '100vh',
        width: '100vw',
      }}
    >
      <Paper
        sx={{
          p: 3,
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          flexDirection: 'column',
        }}
      >
        <Typography>Welcome to ScribeAR.</Typography>
        <AppLink to={PATHS.standalone}>Standalone Mode</AppLink>
        <AppLink to={PATHS.kiosk}>Kiosk Mode</AppLink>
        <AppLink to={PATHS.client}>Client Mode</AppLink>
      </Paper>
    </Box>
  );
};

export default LandingRoute;
