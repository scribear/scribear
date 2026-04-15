import { useState } from 'react';

import Button from '@mui/material/Button';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';

import { useAppDispatch, useAppSelector } from '#src/store/use-redux';

import { KioskServiceStatus } from '../services/kiosk-service-status';
import {
  registerDevice,
  selectKioskServiceStatus,
} from '../stores/kiosk-service-slice';

/**
 * Form component that allows a kiosk device to register with ScribeAR using an
 * activation code. Shows a loading state while registration is in progress and
 * an error message if the provided code is invalid.
 */
export const KioskActivationForm = () => {
  const dispatch = useAppDispatch();
  const kioskServiceStatus = useAppSelector(selectKioskServiceStatus);

  const [activationCode, setActivationCode] = useState('');

  const isLoading = kioskServiceStatus === KioskServiceStatus.REGISTERING;
  const isError = kioskServiceStatus === KioskServiceStatus.REGISTRATION_ERROR;

  const handleActivate = () => {
    dispatch(registerDevice(activationCode));
  };

  const canSubmit = activationCode.length === 8;

  return (
    <Stack spacing={2}>
      <Typography>Device is not registered with ScribeAR.</Typography>
      <TextField
        label="Activation Code"
        value={activationCode}
        onChange={(e) => {
          const next = e.target.value
            .replace(/[^A-Za-z0-9]/g, '')
            .slice(0, 8)
            .toUpperCase();
          setActivationCode(next);
        }}
        slotProps={{
          htmlInput: {
            inputMode: 'text',
            maxLength: 8,
            spellCheck: false,
            autoCapitalize: 'characters',
          },
        }}
        error={isError}
        helperText={
          isError
            ? 'Failed to register device. Is the registration code correct?'
            : 'Enter the 8-character code (letters A–Z and digits 0–9).'
        }
      />
      <Button
        onClick={handleActivate}
        loading={isLoading}
        disabled={!canSubmit || isLoading}
      >
        Activate
      </Button>
    </Stack>
  );
};
