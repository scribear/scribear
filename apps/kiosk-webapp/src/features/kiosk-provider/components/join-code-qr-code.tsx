import Box from '@mui/material/Box';

import { QRCodeSVG } from 'qrcode.react';

// Trailing slash is required: the reverse proxy serves the client webapp at
// `/client/`, and a request to `/client` (no slash) 404s. A scanned QR encodes
// this verbatim, so the slash is what makes the scanned link resolve.
const CLIENT_WEBAPP_URL =
  import.meta.env.VITE_CLIENT_WEBAPP_URL ?? `${window.location.origin}/client/`;

/**
 * Builds a client webapp URL with the join code embedded as a URL config
 * fragment. When scanned, the client webapp reads the join code from the
 * fragment and pre-fills it in the join session modal.
 */
function buildJoinUrl(joinCode: string): string {
  const config = { clientSessionConfig: { joinCode } };
  const encoded = btoa(JSON.stringify(config));
  return `${CLIENT_WEBAPP_URL}#config=${encoded}`;
}

interface JoinCodeQrCodeProps {
  joinCode: string;
}

/** Renders a QR code that encodes a client webapp join link. */
export const JoinCodeQrCode = ({ joinCode }: JoinCodeQrCodeProps) => {
  const joinUrl = buildJoinUrl(joinCode);

  return (
    <Box sx={{ display: 'flex', justifyContent: 'center', mt: 2 }}>
      {/* size is the intrinsic/max px; the style lets it shrink to fit a narrow
          panel (max 200px, square via the SVG viewBox) instead of overflowing.
          `title` gives the QR a text alternative for assistive technology. */}
      <QRCodeSVG
        value={joinUrl}
        size={200}
        title={`QR code to join session, code ${joinCode}`}
        style={{ width: '100%', height: 'auto', maxWidth: 200 }}
      />
    </Box>
  );
};
