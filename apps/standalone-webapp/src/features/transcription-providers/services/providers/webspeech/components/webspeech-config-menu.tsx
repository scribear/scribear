import { useEffect, useState } from 'react';

import Button from '@mui/material/Button';
import InputLabel from '@mui/material/InputLabel';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import Stack from '@mui/material/Stack';

import {
  selectProviderConfig,
  updateProviderConfig,
} from '#src/features/transcription-providers/stores/provider-config-slice';
import { useAppDispatch, useAppSelector } from '#src/store/use-redux';

import { type ProviderConfigMenuProps } from '../../provider-component-registry';
import { ProviderId } from '../../provider-registry';
import { languageTags } from '../config/webspeech-config';

/**
 * Configuration menu for the Web Speech API provider. Allows the user to
 * select the recognition language from a dropdown, with unsaved-change
 * detection on close.
 */
export const WebspeechConfigMenu = ({
  onClose,
  onDirtyChange,
}: ProviderConfigMenuProps) => {
  const dispatch = useAppDispatch();

  const webspeechConfig = useAppSelector((state) =>
    selectProviderConfig(state, ProviderId.WEBSPEECH),
  );

  const [languageTag, setLanguageTag] = useState(webspeechConfig.languageTag);

  const isDirty = languageTag !== webspeechConfig.languageTag;
  useEffect(() => {
    onDirtyChange(isDirty);
  }, [isDirty, onDirtyChange]);

  const handleClose = () => {
    onClose(isDirty);
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
    <>
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
