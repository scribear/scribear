import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Modal from '@mui/material/Modal';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

interface CancelableInfoModalProps {
  isOpen: boolean;
  message: string;
  children?: React.ReactNode;
  onCancel: () => void;
}

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
