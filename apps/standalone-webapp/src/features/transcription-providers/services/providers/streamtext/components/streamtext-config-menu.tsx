import { useEffect, useState } from 'react';

import Button from '@mui/material/Button';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';

import { NumberField } from '@scribear/core-ui';

import {
  selectProviderConfig,
  updateProviderConfig,
} from '#src/features/transcription-providers/stores/provider-config-slice';
import { useAppDispatch, useAppSelector } from '#src/store/use-redux';

import { type ProviderConfigMenuProps } from '../../provider-component-registry';
import { ProviderId } from '../../provider-registry';

/**
 * Configuration menu for the StreamText provider. Allows the user to enter the
 * event name, language, and start position, with unsaved-change detection on
 * close and non-negative integer enforcement for the start position field.
 */
export const StreamtextConfigMenu = ({
  onClose,
  onDirtyChange,
}: ProviderConfigMenuProps) => {
  const dispatch = useAppDispatch();

  const streamtextConfig = useAppSelector((state) =>
    selectProviderConfig(state, ProviderId.STREAMTEXT),
  );

  const [event, setEvent] = useState(streamtextConfig.event);
  const [language, setLanguage] = useState(streamtextConfig.language);
  const [startPosition, setStartPosition] = useState(
    streamtextConfig.startPosition,
  );

  const isDirty =
    event !== streamtextConfig.event ||
    language !== streamtextConfig.language ||
    startPosition !== streamtextConfig.startPosition;
  useEffect(() => {
    onDirtyChange(isDirty);
  }, [isDirty, onDirtyChange]);

  const handleClose = () => {
    onClose(isDirty);
  };

  const saveConfig = () => {
    dispatch(
      updateProviderConfig({
        providerId: ProviderId.STREAMTEXT,
        newConfig: {
          event,
          language,
          startPosition,
        },
      }),
    );
    onClose(false);
  };

  return (
    <>
      <TextField
        label="Event"
        value={event}
        onChange={(e) => {
          setEvent(e.target.value);
        }}
        sx={{ width: 300, pb: 3 }}
      />
      <br />
      <TextField
        label="Language"
        value={language}
        onChange={(e) => {
          setLanguage(e.target.value);
        }}
        sx={{ width: 300, pb: 3 }}
      />
      <br />
      <NumberField
        label="Start Position"
        value={startPosition}
        onValueChange={(val: number | null) => {
          setStartPosition(val ?? 0);
        }}
        step={1}
        style={{ width: 300 }}
      />
      <Stack direction="row" justifyContent="flex-end" gap={1} pt={4}>
        <Button color="error" variant="contained" onClick={handleClose}>
          Cancel
        </Button>
        <Button color="success" variant="contained" onClick={saveConfig}>
          Save
        </Button>
      </Stack>
    </>
  );
};
