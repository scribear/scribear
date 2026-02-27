/**
 * Root of not found page
 */
import Box from '@mui/material/Box';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';

import { AppLink } from '#src/components/ui/app-link';
import { PATHS } from '#src/config/paths';

const NotFoundRoute = () => {
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
        <Typography>Page not found.</Typography>
        <AppLink to={PATHS.landing}>
          Click here to return to the ScribeAR landing page.
        </AppLink>
      </Paper>
    </Box>
  );
};

export default NotFoundRoute;
