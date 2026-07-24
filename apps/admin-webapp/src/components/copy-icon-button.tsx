import { useState } from 'react';

import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import DoneIcon from '@mui/icons-material/Done';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';

export interface CopyIconButtonProps {
  value: string;
  /** Used for the tooltip and `aria-label`, e.g. "join code" -> "Copy join code". */
  label: string;
}

/**
 * Icon-swap copy-to-clipboard control (copy -> checkmark for 2s), extracted
 * from `ActivationCodeDisplay`'s original inline implementation so it isn't
 * duplicated across the join-code UI. Clipboard failures are silently
 * ignored, matching that precedent.
 */
export const CopyIconButton = ({ value, label }: CopyIconButtonProps) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    void navigator.clipboard
      .writeText(value)
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

  return (
    <Tooltip title={copied ? 'Copied' : `Copy ${label}`}>
      <IconButton onClick={handleCopy} aria-label={`Copy ${label}`}>
        {copied ? <DoneIcon color="success" /> : <ContentCopyIcon />}
      </IconButton>
    </Tooltip>
  );
};
