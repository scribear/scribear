import { useId } from 'react';

import CloseIcon from '@mui/icons-material/Close';
import Dialog from '@mui/material/Dialog';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import IconButton from '@mui/material/IconButton';

/**
 * Props for {@link ProviderConfigContainer}.
 */
interface ProviderConfigContainer {
  // Human-readable provider name shown as the modal title.
  displayName: string;
  // Provider-specific form fields to render inside the modal.
  children: React.ReactNode;
  // Called when the user dismisses the modal without saving.
  onClose: () => void;
}

/**
 * Generic modal shell for provider configuration menus. A proper MUI `Dialog`
 * (role="dialog" + focus trap) named by its title, with an explicit, visible
 * close button so it can be dismissed by keyboard/AT without relying on a
 * backdrop click.
 */
export const ProviderConfigContainer = ({
  displayName,
  children,
  onClose,
}: ProviderConfigContainer) => {
  const titleId = useId();
  return (
    <Dialog
      open
      onClose={onClose}
      fullWidth
      maxWidth="md"
      aria-labelledby={titleId}
    >
      <DialogTitle id={titleId} sx={{ pr: 6 }}>
        {displayName} Settings
        <IconButton
          aria-label="Close"
          onClick={onClose}
          sx={{ position: 'absolute', right: 8, top: 8 }}
        >
          <CloseIcon />
        </IconButton>
      </DialogTitle>
      <DialogContent>{children}</DialogContent>
    </Dialog>
  );
};
