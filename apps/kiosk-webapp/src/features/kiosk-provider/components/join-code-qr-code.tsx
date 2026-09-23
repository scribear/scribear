import Box from '@mui/material/Box';

import { QRCodeSVG } from 'qrcode.react';

import { CLIENT_WEBAPP_URL } from '#src/config/client-webapp-url';

/** Maximum intrinsic QR size; responsive styling lets it shrink on narrow panels. */
const QR_SIZE_PX = 320;

/** Quiet zone in modules. The spec requires four; the library defaults to none. */
const QR_MARGIN_MODULES = 4;

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
    <Box sx={{ display: 'flex', justifyContent: 'center' }}>
      {/* Light plate under the code: the background is user-chosen and the
          panel is dark by default, so the symbol brings its own. */}
      <Box
        sx={{
          backgroundColor: 'grey.100',
          borderRadius: 1,
          lineHeight: 0,
          maxWidth: QR_SIZE_PX,
          p: 1,
          width: '100%',
        }}
      >
        {/* `size` is the intrinsic/max px; the style lets it shrink to fit a
            narrow panel. `title` is the text alternative. */}
        <QRCodeSVG
          value={joinUrl}
          size={QR_SIZE_PX}
          level="M"
          marginSize={QR_MARGIN_MODULES}
          bgColor="#ffffff"
          fgColor="#000000"
          title={`QR code to join session, code ${joinCode}`}
          style={{ width: '100%', height: 'auto' }}
        />
      </Box>
    </Box>
  );
};
