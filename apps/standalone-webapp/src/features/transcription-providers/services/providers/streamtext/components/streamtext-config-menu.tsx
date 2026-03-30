import { useState } from 'react';

import TextField from '@mui/material/TextField';

import { ProviderConfigContainer } from '#src/features/transcription-providers/components/provider-config-container';
import {
  selectProviderConfig,
  updateProviderConfig,
} from '#src/features/transcription-providers/stores/provider-config-slice';
import { useAppDispatch, useAppSelector } from '#src/store/use-redux';

import {
  type ProviderConfigMenuProps,
  getProviderDisplayName,
} from '../../provider-component-registry';
import { ProviderId } from '../../provider-registry';

/**
 * Configuration menu for the StreamText provider. Allows the user to enter the
 * event name, language, and start position, with unsaved-change detection on
 * close and non-negative integer enforcement for the start position field.
 */
export const StreamtextConfigMenu = ({ onClose }: ProviderConfigMenuProps) => {
  const dispatch = useAppDispatch();
  const displayName = getProviderDisplayName(ProviderId.STREAMTEXT);

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

  const handleClose = () => {
    const startPosition = parseStartPosition(startPositionInput);
    const isEdited =
      event !== streamtextConfig.event ||
      language !== streamtextConfig.language ||
      startPosition !== streamtextConfig.startPosition;
    onClose(isEdited);
  };

  const saveConfig = () => {
    const startPosition = parseStartPosition(startPositionInput);
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
    <ProviderConfigContainer
      onClose={handleClose}
      onSave={saveConfig}
      displayName={displayName}
    >
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
    </ProviderConfigContainer>
  );
};
