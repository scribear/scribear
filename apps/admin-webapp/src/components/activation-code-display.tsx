import { useEffect, useState } from 'react';

import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import DoneIcon from '@mui/icons-material/Done';
import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import Paper from '@mui/material/Paper';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';

export interface ActivationCodeDisplayProps {
  code: string;
  /** ISO-8601 expiry timestamp. */
  expiry: string;
}

function formatRemaining(ms: number): string {
  if (ms <= 0) return 'Expired';
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes)}:${seconds.toString().padStart(2, '0')}`;
}

/**
 * Big, copyable activation code with a live expiry countdown. Shown after
 * registering/re-registering a device so an operator can type it on the kiosk.
 */
export const ActivationCodeDisplay = ({
  code,
  expiry,
}: ActivationCodeDisplayProps) => {
  const [remainingMs, setRemainingMs] = useState(
    () => new Date(expiry).getTime() - Date.now(),
  );
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const tick = () => {
      setRemainingMs(new Date(expiry).getTime() - Date.now());
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => {
      clearInterval(timer);
    };
  }, [expiry]);

  const handleCopy = () => {
    void navigator.clipboard
      .writeText(code)
      .then(() => {
        setCopied(true);
        setTimeout(() => {
          setCopied(false);
        }, 2000);
      })
      .catch(() => {
        /* clipboard denied — ignore */
      });
  };

  const expired = remainingMs <= 0;

  return (
    <Paper variant="outlined" sx={{ p: 3, textAlign: 'center' }}>
      <Typography variant="overline" color="text.secondary">
        Activation code
      </Typography>
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 1,
        }}
      >
        <Typography
          variant="h3"
          component="p"
          sx={{
            fontFamily: 'monospace',
            letterSpacing: 4,
            color: expired ? 'text.disabled' : 'text.primary',
          }}
        >
          {code}
        </Typography>
        <Tooltip title={copied ? 'Copied' : 'Copy'}>
          <IconButton onClick={handleCopy} aria-label="Copy activation code">
            {copied ? <DoneIcon color="success" /> : <ContentCopyIcon />}
          </IconButton>
        </Tooltip>
      </Box>
      <Typography
        variant="body2"
        color={expired ? 'error' : 'text.secondary'}
        sx={{ mt: 1 }}
      >
        {expired
          ? 'This code has expired.'
          : `Expires in ${formatRemaining(remainingMs)}`}
      </Typography>
      {/* The visible countdown above ticks every second and deliberately has
          no live region — announcing it that often would spam a screen
          reader. This region's content only ever changes once, on the
          valid -> expired transition, so it announces that one meaningful
          status change without the per-second noise. */}
      <Box
        aria-live="polite"
        sx={{
          position: 'absolute',
          width: 1,
          height: 1,
          overflow: 'hidden',
          clip: 'rect(0 0 0 0)',
          whiteSpace: 'nowrap',
        }}
      >
        {expired ? 'This code has expired.' : ''}
      </Box>
    </Paper>
  );
};
