import { useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Grid from '@mui/material/Grid';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import Paper from '@mui/material/Paper';

import { RoomServiceStatus } from '#src/features/room-provider/services/room-service-status';
import {
  registerDevice,
  selectRoomServiceStatus,
} from '#src/features/room-provider/stores/room-service-slice';
import { useAppDispatch, useAppSelector } from '#src/store/use-redux';

const ALPHANUMERIC_KEYS = [
  '1', '2', '3', '4', '5', '6', '7', '8', '9', '0',
  'Q', 'W', 'E', 'R', 'T', 'Y', 'U', 'I', 'O', 'P',
  'A', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L',
  'Z', 'X', 'C', 'V', 'B', 'N', 'M',
];

const MAX_CODE_LENGTH = 8;

export const ActivationView = () => {
  const dispatch = useAppDispatch();
  const status = useAppSelector(selectRoomServiceStatus);
  const [code, setCode] = useState('');

  const isLoading = status === RoomServiceStatus.REGISTERING;
  const isError = status === RoomServiceStatus.REGISTRATION_ERROR;

  const appendChar = (char: string) => {
    setCode((prev) => (prev.length < MAX_CODE_LENGTH ? prev + char : prev));
  };

  const deleteChar = () => setCode((prev) => prev.slice(0, -1));
  const clearCode = () => setCode('');

  const handleActivate = () => {
    if (code.length === MAX_CODE_LENGTH) {
      dispatch(registerDevice(code));
    }
  };

  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100vh',
        gap: 3,
        p: 4,
        bgcolor: 'background.default',
      }}
    >
      <Typography variant="h4">Activate Device</Typography>
      <Typography variant="body1" color="text.secondary" textAlign="center">
        Enter the activation code shown in the ScribeAR admin portal.
      </Typography>

      {/* Code display */}
      <Paper
        elevation={2}
        sx={{ px: 4, py: 2, minWidth: 320, textAlign: 'center' }}
      >
        <Typography
          variant="h3"
          fontFamily="monospace"
          letterSpacing={6}
          color={isError ? 'error.main' : 'text.primary'}
        >
          {code.padEnd(MAX_CODE_LENGTH, '_')}
        </Typography>
        {isError && (
          <Typography color="error.main" variant="body2" mt={1}>
            Invalid activation code. Please try again.
          </Typography>
        )}
      </Paper>

      {/* Physical keyboard fallback */}
      <TextField
        label="Or type code here"
        value={code}
        onChange={(e) =>
          setCode(
            e.target.value
              .toUpperCase()
              .replace(/[^A-Z0-9]/g, '')
              .slice(0, MAX_CODE_LENGTH),
          )
        }
        inputProps={{
          maxLength: MAX_CODE_LENGTH,
          style: { textAlign: 'center', letterSpacing: 4 },
        }}
        sx={{ width: 280 }}
      />

      {/* On-screen keyboard */}
      <Box sx={{ maxWidth: 480 }}>
        <Grid container spacing={1} justifyContent="center">
          {ALPHANUMERIC_KEYS.map((key) => (
            <Grid key={key}>
              <Button
                variant="outlined"
                onClick={() => appendChar(key)}
                sx={{
                  minWidth: 44,
                  minHeight: 44,
                  fontSize: '1.1rem',
                  fontFamily: 'monospace',
                }}
                disabled={isLoading}
              >
                {key}
              </Button>
            </Grid>
          ))}
          <Grid>
            <Button
              variant="outlined"
              color="warning"
              onClick={deleteChar}
              sx={{ minWidth: 80, minHeight: 44 }}
              disabled={isLoading}
            >
              ⌫
            </Button>
          </Grid>
          <Grid>
            <Button
              variant="outlined"
              color="error"
              onClick={clearCode}
              sx={{ minWidth: 80, minHeight: 44 }}
              disabled={isLoading}
            >
              CLR
            </Button>
          </Grid>
        </Grid>
      </Box>

      <Button
        variant="contained"
        size="large"
        onClick={handleActivate}
        disabled={code.length !== MAX_CODE_LENGTH || isLoading}
        loading={isLoading}
        sx={{ mt: 2, px: 6 }}
      >
        Activate
      </Button>
    </Box>
  );
};
