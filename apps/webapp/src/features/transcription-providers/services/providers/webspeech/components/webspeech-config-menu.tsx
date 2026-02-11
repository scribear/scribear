import { useState } from 'react';

import InputLabel from '@mui/material/InputLabel';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';

import { ProviderConfigContainer } from '#src/features/transcription-providers/components/provider-config-container';
import {
  selectProviderConfig,
  updateProviderConfig,
} from '#src/features/transcription-providers/stores/provider-config-slice';
import { useAppDispatch, useAppSelector } from '#src/stores/use-redux';

import {
  type ProviderConfigMenuProps,
  getProviderDisplayName,
} from '../../provider-component-registry';
import { ProviderId } from '../../provider-registry';
import { languageTags } from '../config/webspeech-config';

export const WebspeechConfigMenu = ({ onClose }: ProviderConfigMenuProps) => {
  const dispatch = useAppDispatch();
  const displayName = getProviderDisplayName(ProviderId.WEBSPEECH);

  const webspeechConfig = useAppSelector((state) =>
    selectProviderConfig(state, ProviderId.WEBSPEECH),
  );

  const [languageTag, setLanguageTag] = useState(webspeechConfig.languageTag);

  const handleClose = () => {
    const isEdited = languageTag !== webspeechConfig.languageTag;
    onClose(isEdited);
  };

  const saveConfig = () => {
    dispatch(
      updateProviderConfig({
        providerId: ProviderId.WEBSPEECH,
        newConfig: {
          languageTag,
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
      <InputLabel id="webspeech-language-select-label">Language</InputLabel>
      <Select
        labelId="webspeech-language-select-label"
        id="webspeech-language-select"
        label="Language"
        displayEmpty
        value={languageTag}
        renderValue={(value) => languageTags[value]}
        onChange={(e) => {
          setLanguageTag(e.target.value);
        }}
        sx={{ width: 300 }}
      >
        {Object.keys(languageTags).map((tag) => (
          <MenuItem value={tag} key={tag}>
            {languageTags[tag]}
          </MenuItem>
        ))}
      </Select>
    </ProviderConfigContainer>
  );
};
