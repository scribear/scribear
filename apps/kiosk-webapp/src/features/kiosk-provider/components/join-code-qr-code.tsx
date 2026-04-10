import Box from '@mui/material/Box';
import { QRCodeSVG } from 'qrcode.react';

const CLIENT_WEBAPP_URL =
  import.meta.env.VITE_CLIENT_WEBAPP_URL ?? `${window.location.origin}/client`;

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
      <QRCodeSVG value={joinUrl} size={200} />
    </Box>
  );
};
