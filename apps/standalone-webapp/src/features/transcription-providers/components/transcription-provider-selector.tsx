import { useState } from 'react';

import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import SettingsIcon from '@mui/icons-material/Settings';
import IconButton from '@mui/material/IconButton';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemText from '@mui/material/ListItemText';
import Popover from '@mui/material/Popover';
import Tooltip from '@mui/material/Tooltip';

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
 * A single row within the provider selector list. The provider name is a
 * selectable button and the settings gear is a separate, individually-labelled
 * button rendered as the row's secondary action — both are in the normal tab
 * order (unlike a `role="menu"`, which would hide the non-`menuitem` gear from
 * arrow-key navigation).
 */
const TranscriptionProviderOption = ({
  id,
  selected,
  onSelectProvider,
  onConfigureProvider,
}: TranscriptionProviderOptionProps) => {
  const name = getProviderDisplayName(id);
  return (
    <ListItem
      disablePadding
      secondaryAction={
        <Tooltip title={`Configure ${name}`}>
          <IconButton
            edge="end"
            aria-label={`Configure ${name}`}
            onClick={onConfigureProvider}
          >
            <SettingsIcon />
          </IconButton>
        </Tooltip>
      }
    >
      <ListItemButton selected={selected} onClick={onSelectProvider}>
        <ListItemText primary={name} />
      </ListItemButton>
    </ListItem>
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
      <Tooltip title="Switch or configure providers">
        <IconButton
          color="inherit"
          aria-label="Switch or configure providers"
          aria-haspopup="true"
          aria-expanded={isSelectorMenuOpen}
          onClick={showSelectorMenu}
        >
          <ExpandMoreIcon />
        </IconButton>
      </Tooltip>
      <Popover
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
        <List>
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
          <ListItem disablePadding>
            <ListItemButton
              selected={targetProviderId === null}
              onClick={() => {
                handleSelectProvider(null);
              }}
            >
              <ListItemText primary="No Provider" />
            </ListItemButton>
          </ListItem>
        </List>
      </Popover>
    </>
  );
};
