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

  return (
    <Stack spacing={2}>
      <Typography>Device is not registered with ScribeAR.</Typography>
      <TextField
        label="Activation Code"
        value={activationCode}
        onChange={(e) => {
          setActivationCode(e.target.value);
        }}
        error={isError}
        helperText={
          isError &&
          'Failed to register device. Is the registration code correct?'
        }
      />
      <Button onClick={handleActivate} loading={isLoading}>
        Activate
      </Button>
    </Stack>
  );
};
