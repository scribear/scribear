import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Modal from '@mui/material/Modal';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

/**
 * Props for the {@link CancelableInfoModal} component.
 *
 * @param isOpen Whether the modal is currently visible.
 * @param message Descriptive text displayed at the top of the modal.
 * @param children Optional content rendered below the message.
 * @param onCancel Called when the Cancel button or the backdrop is clicked.
 */
interface CancelableInfoModalProps {
  isOpen: boolean;
  message: string;
  children?: React.ReactNode;
  onCancel: () => void;
}

/**
 * Informational modal dialog with a single Cancel button.
 *
 * Displays a `message` and an optional `children` content slot. Clicking Cancel
 * or the backdrop calls `onCancel` to dismiss the modal.
 */
export const CancelableInfoModal = ({
  isOpen,
  message,
  children,
  onCancel,
}: CancelableInfoModalProps) => {
  return (
    <Modal open={isOpen} onClose={onCancel}>
      <Paper
        sx={{
          position: 'absolute',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          width: '100%',
          maxWidth: 400,
          p: 4,
        }}
      >
        <Typography textAlign="center" pb={4}>
          {message}
        </Typography>
        <Box sx={{ pb: 4, width: '100%' }}>{children}</Box>
        <Stack direction="row" justifyContent="space-around">
          <Button onClick={onCancel} color="error" variant="contained">
            Cancel
          </Button>
        </Stack>
      </Paper>
    </Modal>
  );
};
