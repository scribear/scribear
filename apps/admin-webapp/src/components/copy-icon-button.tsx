import { useState } from 'react';

import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import DoneIcon from '@mui/icons-material/Done';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';

import { useToast } from '#src/lib/toast-context';

export interface CopyIconButtonProps {
  value: string;
  /** Used for the tooltip and `aria-label`, e.g. "join code" -> "Copy join code". */
  label: string;
}

/**
 * Icon-swap copy-to-clipboard control (copy -> checkmark for 2s), extracted
 * from `ActivationCodeDisplay`'s original inline implementation so it isn't
 * duplicated across the join-code UI.
 *
 * **`navigator.clipboard` may not exist at all.** It requires a secure
 * context, and this console is reachable over plain HTTP in local
 * deployments — which is exactly where an operator is most likely to be
 * copying an activation code by hand. There the property is `undefined`, so
 * `.writeText` throws *synchronously* and a lone `.catch()` never runs: the
 * button appeared to do nothing and the error went to the console. Both that
 * case and a genuine rejection now report through the toast, which is an
 * assertive `role="alert"` region and so reaches a screen reader rather than
 * only the eye. Every caller renders the value as selectable text beside this
 * button, so a failed copy costs the operator a selection, not the value.
 */
export const CopyIconButton = ({ value, label }: CopyIconButtonProps) => {
  const [copied, setCopied] = useState(false);
  const { showError } = useToast();

  const handleCopy = () => {
    if (typeof navigator.clipboard === 'undefined') {
      showError(
        `Clipboard access isn't available on this connection — select and copy the ${label} manually.`,
      );
      return;
    }
    void navigator.clipboard
      .writeText(value)
      .then(() => {
        setCopied(true);
        setTimeout(() => {
          setCopied(false);
        }, 2000);
      })
      .catch(() => {
        showError(`Couldn't copy the ${label} — select and copy it manually.`);
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
