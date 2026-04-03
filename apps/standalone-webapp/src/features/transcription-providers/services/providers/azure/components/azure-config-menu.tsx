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
 * Configuration menu for the Azure Speech-to-Text provider. Allows the user
 * to enter a Region ID and API Key, with unsaved-change detection on close.
 */
export const AzureConfigMenu = ({
  onClose,
  onDirtyChange,
}: ProviderConfigMenuProps) => {
  const dispatch = useAppDispatch();

  const azureConfig = useAppSelector((state) =>
    selectProviderConfig(state, ProviderId.AZURE),
  );

  const [apiKey, setApiKey] = useState(azureConfig.apiKey);
  const [regionId, setRegionId] = useState(azureConfig.regionId);

  const isDirty =
    apiKey !== azureConfig.apiKey || regionId !== azureConfig.regionId;
  useEffect(() => {
    onDirtyChange(isDirty);
  }, [isDirty, onDirtyChange]);

  const handleClose = () => {
    onClose(isDirty);
  };

  const saveConfig = () => {
    dispatch(
      updateProviderConfig({
        providerId: ProviderId.AZURE,
        newConfig: {
          apiKey,
          regionId,
        },
      }),
    );
    onClose(false);
  };

  return (
    <>
      <TextField
        label="Region ID"
        value={regionId}
        onChange={(e) => {
          setRegionId(e.target.value);
        }}
        sx={{ width: 300, pb: 4 }}
      />
      <br />
      <TextField
        label="API Key"
        type="password"
        value={apiKey}
        onChange={(e) => {
          setApiKey(e.target.value);
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
