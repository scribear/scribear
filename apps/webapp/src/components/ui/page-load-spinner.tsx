/**
 * Provides loading spinner component for use when page is loading
 */
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';

export const PageLoadSpinner = () => {
  return (
    <Box
      sx={{
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        height: '100vh',
        width: '100vw',
      }}
    >
      <CircularProgress />
    </Box>
  );
};
