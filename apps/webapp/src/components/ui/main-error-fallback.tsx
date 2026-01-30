/**
 * Defines global error fallback component
 * Indicates to user that an error occurred and provides refresh button
 */
import Refresh from '@mui/icons-material/Refresh';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';

export const MainErrorFallback = () => {
  const reloadPage = () => {
    window.location.reload();
  };

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
        <Typography>
          An unexpected error occurred. Try refreshing the page.
        </Typography>
        <Button
          startIcon={<Refresh />}
          onClick={() => {
            reloadPage();
          }}
        >
          Refresh Page
        </Button>
      </Paper>
    </Box>
  );
};
