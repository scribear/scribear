import CheckCircleOutlinedIcon from '@mui/icons-material/CheckCircleOutlined';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

import {
  AA_NON_TEXT_CONTRAST,
  AA_TEXT_CONTRAST,
  contrastRatio,
} from '#src/utils/color-contrast.js';

/**
 * Props for {@link ContrastReadout}.
 */
interface ContrastReadoutProps {
  backgroundColor: string;
  accentColor: string;
  transcriptionColor: string;
}

interface ContrastRowProps {
  label: string;
  ratio: number;
  threshold: number;
}

/**
 * One contrast line. Pass/fail is conveyed by the icon shape AND the text (not
 * colour alone, SC 1.4.1); the text itself uses `text.primary` so it stays
 * readable on any themed drawer background.
 */
const ContrastRow = ({ label, ratio, threshold }: ContrastRowProps) => {
  const passes = ratio >= threshold;
  return (
    <Stack
      direction="row"
      spacing={0.5}
      sx={{
        alignItems: 'center',
      }}
    >
      {passes ? (
        <CheckCircleOutlinedIcon
          fontSize="small"
          aria-hidden="true"
          sx={{ color: 'success.main' }}
        />
      ) : (
        <WarningAmberIcon
          fontSize="small"
          aria-hidden="true"
          sx={{ color: 'warning.main' }}
        />
      )}
      <Typography variant="body2" sx={{ color: 'text.primary' }}>
        {label}: {ratio.toFixed(1)}:1
        {passes ? '' : ` — low, aim for ${threshold.toString()}:1`}
      </Typography>
    </Stack>
  );
};

/**
 * Live WCAG contrast readout for the current theme colors, so a user picking
 * colours can see when a caption/background or accent/background pair becomes
 * unreadable. Announced politely as the colours change. (SC 1.4.3 support.)
 */
export const ContrastReadout = ({
  backgroundColor,
  accentColor,
  transcriptionColor,
}: ContrastReadoutProps) => {
  const captionRatio = contrastRatio(transcriptionColor, backgroundColor);
  const accentRatio = contrastRatio(accentColor, backgroundColor);

  return (
    <Stack role="status" aria-live="polite" spacing={0.5} sx={{ mt: 1 }}>
      <ContrastRow
        label="Caption text"
        ratio={captionRatio}
        threshold={AA_TEXT_CONTRAST}
      />
      <ContrastRow
        label="Accent"
        ratio={accentRatio}
        threshold={AA_NON_TEXT_CONTRAST}
      />
    </Stack>
  );
};
