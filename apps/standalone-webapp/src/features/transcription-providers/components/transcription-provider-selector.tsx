import { useState } from 'react';

import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import SettingsIcon from '@mui/icons-material/Settings';
import IconButton from '@mui/material/IconButton';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';

import { useAppDispatch, useAppSelector } from '#src/store/use-redux';

import { getProviderDisplayName } from '../services/providers/provider-component-registry';
import { ProviderId } from '../services/providers/provider-registry';
import {
  selectTargetProviderId,
  setPreferredProviderId,
} from '../stores/provider-preferences-slice';
import { openConfigMenu } from '../stores/provider-ui-slice';

/**
 * Props for {@link TranscriptionProviderOption}.
 */
interface TranscriptionProviderOptionProps {
  // The provider this row represents.
  id: ProviderId;
  // Whether this provider is currently the active selection.
  selected: boolean;
  // Called when the user clicks the provider name to select it.
  onSelectProvider: () => void;
  // Called when the user clicks the settings icon to configure the provider.
  onConfigureProvider: () => void;
}

/**
 * A single row within the provider selector dropdown. Renders the provider
 * display name as a selectable menu item alongside a settings icon button.
 */
const TranscriptionProviderOption = ({
  id,
  selected,
  onSelectProvider,
  onConfigureProvider,
}: TranscriptionProviderOptionProps) => {
  return (
    <Stack direction="row" alignItems="center" justifyContent="space-between">
      <MenuItem
        onClick={onSelectProvider}
        sx={{ width: '100%', p: 2 }}
        selected={selected}
      >
        <Typography>{getProviderDisplayName(id)}</Typography>
      </MenuItem>
      <IconButton onClick={onConfigureProvider} sx={{ p: 2, borderRadius: 0 }}>
        <SettingsIcon />
      </IconButton>
    </Stack>
  );
};

/**
 * Dropdown button that lets the user switch the active transcription provider
 * or open a provider's configuration menu. Renders a "No Provider" option to
 * deactivate transcription.
 */
export const TranscriptionProviderSelector = () => {
  const dispatch = useAppDispatch();
  const targetProviderId = useAppSelector(selectTargetProviderId);

  const [selectorMenuAnchorEl, setSelectorMenuAnchorEl] =
    useState<HTMLButtonElement | null>(null);
  const isSelectorMenuOpen = Boolean(selectorMenuAnchorEl);

  const showSelectorMenu = (event: React.MouseEvent<HTMLButtonElement>) => {
    setSelectorMenuAnchorEl(event.currentTarget);
  };
  const hideSelectorMenu = () => {
    setSelectorMenuAnchorEl(null);
  };

  const handleSelectProvider = (id: ProviderId | null) => {
    hideSelectorMenu();
    dispatch(setPreferredProviderId(id));
  };

  return (
    <>
      <Tooltip title="Switch or config providers">
        <IconButton color="inherit" onClick={showSelectorMenu}>
          <ExpandMoreIcon />
        </IconButton>
      </Tooltip>
      <Menu
        open={isSelectorMenuOpen}
        anchorEl={selectorMenuAnchorEl}
        onClose={hideSelectorMenu}
        anchorOrigin={{
          vertical: 'bottom',
          horizontal: 'center',
        }}
        transformOrigin={{
          vertical: 'top',
          horizontal: 'center',
        }}
      >
        {Object.values(ProviderId).map((id) => (
          <TranscriptionProviderOption
            key={id}
            id={id}
            selected={id === targetProviderId}
            onSelectProvider={() => {
              handleSelectProvider(id);
            }}
            onConfigureProvider={() => {
              hideSelectorMenu();
              dispatch(openConfigMenu(id));
            }}
          />
        ))}
        <MenuItem
          onClick={() => {
            handleSelectProvider(null);
          }}
          sx={{ width: '100%', p: 2 }}
          selected={targetProviderId === null}
        >
          <Typography>No Provider</Typography>
        </MenuItem>
      </Menu>
    </>
  );
};
