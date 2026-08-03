import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';

/**
 * Full-page centered loading spinner.
 */
export const PageLoadSpinner = () => {
  return (
    <Box
      role="status"
      sx={{
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        height: '100vh',
        width: '100vw',
      }}
    >
      <CircularProgress aria-label="Loading" />
    </Box>
  );
};
