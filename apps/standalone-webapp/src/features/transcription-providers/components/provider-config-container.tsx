import Box from '@mui/material/Box';
import Modal from '@mui/material/Modal';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';

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
 * Generic modal shell for provider configuration menus. Renders a centered
 * MUI `Paper` modal with a title derived from `displayName` and a slot for
 * form content.
 */
export const ProviderConfigContainer = ({
  displayName,
  children,
  onClose,
}: ProviderConfigContainer) => {
  return (
    <Modal open onClose={onClose}>
      <Paper
        sx={{
          position: 'absolute',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          width: '100%',
          maxWidth: 800,
          p: 4,
        }}
      >
        <Typography variant="h5">{displayName} Settings</Typography>
        <Box paddingTop={4}>{children}</Box>
      </Paper>
    </Modal>
  );
};
