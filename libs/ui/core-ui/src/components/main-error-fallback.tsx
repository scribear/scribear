import { useEffect, useRef } from 'react';

import Refresh from '@mui/icons-material/Refresh';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';

/**
 * Full-page error fallback that prompts the user to refresh.
 */
export const MainErrorFallback = () => {
  const messageRef = useRef<HTMLParagraphElement>(null);

  // Move focus to the error message so screen-reader users are taken to it
  // immediately (the `role="alert"` also announces it). SC 4.1.3
  useEffect(() => {
    messageRef.current?.focus();
  }, []);

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
        <Typography ref={messageRef} role="alert" tabIndex={-1}>
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
