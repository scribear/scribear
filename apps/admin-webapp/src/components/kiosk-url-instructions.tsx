import { useState } from 'react';

import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import DoneIcon from '@mui/icons-material/Done';
import Box from '@mui/material/Box';
import DialogContentText from '@mui/material/DialogContentText';
import IconButton from '@mui/material/IconButton';
import Link from '@mui/material/Link';
import Tooltip from '@mui/material/Tooltip';

import { OpensInNewTab } from '#src/components/opens-in-new-tab';
import { kioskUrl } from '#src/lib/kiosk-url';
import { useToast } from '#src/lib/toast-context';

/**
 * "On the kiosk browser, open <url> and enter this code" line shown after
 * registering or re-registering a device (`RegisterDeviceDialog`,
 * `ReregisterResultDialog`). Replaces the old bare `/kiosk` path with a full,
 * clickable link plus its own copy button.
 *
 * This copies the *URL*, not the activation code — the code sitting right
 * above it (`ActivationCodeDisplay`) already has its own "Copy activation
 * code" button, so copying the code again here would be a second control for
 * the same value. The two buttons' accessible names ("Copy activation code"
 * vs. "Copy kiosk URL") keep their targets unambiguous.
 *
 * `navigator.clipboard` requires a secure context, and this console is
 * reachable over plain HTTP in local deployments, so the API may simply not
 * exist — calling `.writeText` on it would throw rather than reject. Both
 * that case and an outright write rejection are surfaced through the existing
 * toast (an assertive `role="alert"` region, so it reaches a screen reader,
 * not only the eye) telling the operator to select the link instead; the URL
 * itself is always rendered as plain selectable text, so nothing is lost when
 * the copy can't happen.
 */
export const KioskUrlInstructions = () => {
  const { showSuccess, showError } = useToast();
  const [copied, setCopied] = useState(false);
  const url = kioskUrl();

  const handleCopy = () => {
    if (typeof navigator.clipboard === 'undefined') {
      showError(
        "Clipboard access isn't available on this connection — select and copy the link above instead.",
      );
      return;
    }
    navigator.clipboard
      .writeText(url)
      .then(() => {
        setCopied(true);
        showSuccess('Kiosk URL copied.');
        setTimeout(() => {
          setCopied(false);
        }, 2000);
      })
      .catch(() => {
        showError(
          "Couldn't copy the kiosk URL — select and copy the link above instead.",
        );
      });
  };

  return (
    <DialogContentText sx={{ mt: 2 }}>
      On the kiosk browser, open{' '}
      <Link
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        sx={{ wordBreak: 'break-all' }}
      >
        {url}
        <OpensInNewTab />
      </Link>{' '}
      <Box
        component="span"
        sx={{ display: 'inline-block', verticalAlign: 'middle' }}
      >
        <Tooltip title={copied ? 'Copied' : 'Copy kiosk URL'}>
          <IconButton
            size="small"
            onClick={handleCopy}
            aria-label="Copy kiosk URL"
          >
            {copied ? (
              <DoneIcon color="success" fontSize="small" />
            ) : (
              <ContentCopyIcon fontSize="small" />
            )}
          </IconButton>
        </Tooltip>
      </Box>{' '}
      and enter this code.
    </DialogContentText>
  );
};
