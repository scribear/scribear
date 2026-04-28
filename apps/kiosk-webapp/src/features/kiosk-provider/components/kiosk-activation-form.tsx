import { useState } from 'react';

import Button from '@mui/material/Button';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';

import { useAppDispatch, useAppSelector } from '#src/store/use-redux';

import { activateDevice, selectRegistrationError } from '../stores/kiosk-slice';

/**
 * Form component that allows a kiosk device to register with ScribeAR using an
 * activation code. Surfaces the latest registration error message from the
 * service, if any.
 */
export const KioskActivationForm = () => {
  const dispatch = useAppDispatch();
  const registrationError = useAppSelector(selectRegistrationError);

  const [activationCode, setActivationCode] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleActivate = () => {
    setSubmitting(true);
    dispatch(activateDevice(activationCode));
  };

  return (
    <Stack spacing={2}>
      <Typography>Device is not registered with ScribeAR.</Typography>
      <TextField
        label="Activation Code"
        value={activationCode}
        onChange={(e) => {
          setActivationCode(e.target.value);
          setSubmitting(false);
        }}
        error={registrationError !== null}
        helperText={registrationError ?? ''}
      />
      <Button onClick={handleActivate} loading={submitting}>
        Activate
      </Button>
    </Stack>
  );
};
