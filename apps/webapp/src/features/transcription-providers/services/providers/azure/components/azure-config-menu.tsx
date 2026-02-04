import { useState } from 'react';

import TextField from '@mui/material/TextField';

import { ProviderConfigContainer } from '@/features/transcription-providers/components/provider-config-container';
import {
  selectProviderConfig,
  updateProviderConfig,
} from '@/features/transcription-providers/stores/provider-config-slice';
import { useAppDispatch, useAppSelector } from '@/stores/use-redux';

import {
  type ProviderConfigMenuProps,
  getProviderDisplayName,
} from '../../provider-component-registry';
import { ProviderId } from '../../provider-registry';

export const AzureConfigMenu = ({ onClose }: ProviderConfigMenuProps) => {
  const dispatch = useAppDispatch();
  const displayName = getProviderDisplayName(ProviderId.AZURE);

  const azureConfig = useAppSelector((state) =>
    selectProviderConfig(state, ProviderId.AZURE),
  );

  const [apiKey, setApiKey] = useState(azureConfig.apiKey);
  const [regionId, setRegionId] = useState(azureConfig.regionId);

  const handleClose = () => {
    const isEdited =
      apiKey !== azureConfig.apiKey || regionId !== azureConfig.regionId;
    onClose(isEdited);
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
    <ProviderConfigContainer
      onClose={handleClose}
      onSave={saveConfig}
      displayName={displayName}
    >
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
    </ProviderConfigContainer>
  );
};
