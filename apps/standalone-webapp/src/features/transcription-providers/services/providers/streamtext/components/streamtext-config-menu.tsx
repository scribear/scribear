import { useEffect, useState } from 'react';

import Button from '@mui/material/Button';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';

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
  const [startPositionInput, setStartPositionInput] = useState(
    streamtextConfig.startPosition.toString(),
  );

  // Keep startPosition non-negative so StreamText cursor is always valid.
  const parseStartPosition = (value: string) => {
    const parsed = Number.parseInt(value, 10);
    if (Number.isNaN(parsed)) return 0;
    return Math.max(0, parsed);
  };

  const startPosition = parseStartPosition(startPositionInput);
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
      <TextField
        label="Start Position"
        type="number"
        value={startPositionInput}
        onChange={(e) => {
          setStartPositionInput(e.target.value);
        }}
        slotProps={{
          htmlInput: {
            min: 0,
          },
        }}
        sx={{ width: 300 }}
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
