import { useState } from 'react';

import Alert from '@mui/material/Alert';
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

  // Derive loading rather than resetting it in an effect: a registration error
  // is the async result of the last attempt, so the button stops loading as soon
  // as one arrives instead of staying stuck disabled after a failure. (P4)
  const isSubmitting = submitting && registrationError === null;

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
        }}
        error={registrationError !== null}
      />
      {registrationError !== null && (
        // role="alert" (MUI Alert default) announces the async failure. SC 4.1.3
        <Alert severity="error">{registrationError}</Alert>
      )}
      <Button onClick={handleActivate} loading={isSubmitting}>
        Activate
      </Button>
    </Stack>
  );
};
