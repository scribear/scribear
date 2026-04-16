import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

export const DisplayNotActivated = () => {
  return (
    <Box
      sx={{
        height: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        bgcolor: 'background.default',
      }}
    >
      <Stack spacing={2} alignItems="center">
        <Typography variant="h3" color="text.secondary">
          ScribeAR Room Display
        </Typography>
        <Typography variant="h5" color="text.secondary">
          Not activated
        </Typography>
        <Typography variant="body1" color="text.secondary">
          Use the touchscreen to activate this room display.
        </Typography>
      </Stack>
    </Box>
  );
};
