import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Modal from '@mui/material/Modal';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

interface ProviderConfigContainer {
  displayName: string;
  children: React.ReactNode;
  onClose: () => void;
  onSave: () => void;
}

export const ProviderConfigContainer = ({
  displayName,
  children,
  onClose,
  onSave,
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
        <Box paddingY={4}>{children}</Box>
        <Stack direction="row" justifyContent="flex-end">
          <Button color="success" variant="contained" onClick={onSave}>
            Save
          </Button>
        </Stack>
      </Paper>
    </Modal>
  );
};
