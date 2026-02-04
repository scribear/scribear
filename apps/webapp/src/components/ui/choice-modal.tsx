import Box from '@mui/material/Box';
import Button, { type ButtonProps } from '@mui/material/Button';
import Modal from '@mui/material/Modal';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

interface ChoiceModalProps {
  isOpen: boolean;
  message: string;
  leftColor?: ButtonProps['color'];
  rightColor?: ButtonProps['color'];
  leftAction?: string;
  rightAction: string;
  onCancel: () => void;
  onLeftAction?: () => void;
  onRightAction: () => void;
  children?: React.ReactNode;
}

export const ChoiceModal = ({
  isOpen,
  message,
  leftColor = 'error',
  rightColor = 'info',
  leftAction = 'Cancel',
  rightAction,
  onCancel,
  onLeftAction = onCancel,
  onRightAction,
  children,
}: ChoiceModalProps) => {
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
        {children ? <Box sx={{ pb: 4 }}>{children}</Box> : null}
        <Stack direction="row" justifyContent="space-between">
          <Button onClick={onLeftAction} color={leftColor} variant="contained">
            {leftAction}
          </Button>
          <Button
            onClick={onRightAction}
            color={rightColor}
            variant="contained"
          >
            {rightAction}
          </Button>
        </Stack>
      </Paper>
    </Modal>
  );
};
