// Note: this version of @mui/icons-material only ships the "outlined" error
// glyph as `ErrorOutlineOutlined` (the bare `ErrorOutline` export was
// dropped); its path is identical to the classic "error outline" icon.
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutlineOutlined';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import Box from '@mui/material/Box';
import Slide from '@mui/material/Slide';
import Typography from '@mui/material/Typography';
import useMediaQuery from '@mui/material/useMediaQuery';

/**
 * Severity of a connection problem. Drives both the icon and the (fixed,
 * non-theme-relative) color pairing below.
 */
export type ConnectionStatusSeverity = 'warning' | 'error';

/**
 * Props for {@link ConnectionStatusBanner}.
 *
 * @param open Whether the banner is currently shown. `false` fully unmounts
 * the banner rather than hiding it, so re-opening for a new problem is a
 * fresh DOM insertion (see component doc for why that matters).
 * @param severity Selects the icon and color pairing.
 * @param message The status text shown to the user, e.g. "Reconnecting to
 * the transcription service…".
 */
export interface ConnectionStatusBannerProps {
  open: boolean;
  severity: ConnectionStatusSeverity;
  message: string;
}

/**
 * Fixed (not theme-derived) colors for each severity. This banner reports on
 * the connection to the transcription service itself, so it must stay
 * readable no matter what background/accent colors a user has picked in the
 * app's theme customizer — unlike most of this codebase's UI, it deliberately
 * does NOT read from `theme.palette`.
 *
 * MUI's stock `warning.main` (#ed6c02) against white `contrastText` is a
 * well-known AA failure (~2.9:1, SC 1.4.3 needs 4.5:1 for text), so these are
 * hand-picked and measured with the WCAG relative-luminance/contrast formula
 * (same formula as `theme-customization-ui`'s `color-contrast.ts`; not
 * imported from there to keep these leaf packages dependency-free of each
 * other — the formula is reproduced in this package's tests instead).
 *
 * Both pairs use white text/icon on a dark tint of the severity color:
 *  - warning: #5c3d00 background vs #ffffff text/icon → 9.89:1
 *  - error:   #5a1a1a background vs #ffffff text/icon → 13.15:1
 * Both comfortably clear SC 1.4.3 (text, >=4.5:1) and SC 1.4.11 (non-text /
 * icon, >=3:1).
 */
const SEVERITY_COLORS: Record<
  ConnectionStatusSeverity,
  { background: string; foreground: string }
> = {
  warning: { background: '#5c3d00', foreground: '#ffffff' }, // 9.89:1
  error: { background: '#5a1a1a', foreground: '#ffffff' }, // 13.15:1
};

// Slide duration; forced to 0 under prefers-reduced-motion below.
const SLIDE_DURATION_MS = 200;

/**
 * Full-width status bar pinned to the bottom of the viewport, reporting the
 * app's connection to the transcription service (lost / retrying / at
 * capacity). Non-blocking: unlike {@link MainErrorFallback} this never moves
 * focus, since the user's captioning session keeps running underneath it.
 *
 * Renders nothing when `open` is `false` — the subtree is unmounted, not
 * just hidden with CSS, so that toggling from one problem to the next (even
 * with the same `message`) is always a fresh DOM insertion. That's what
 * reliably re-triggers a screen-reader announcement on every distinct
 * problem, not just the first one.
 */
export const ConnectionStatusBanner = ({
  open,
  severity,
  message,
}: ConnectionStatusBannerProps) => {
  const prefersReducedMotion = useMediaQuery(
    '(prefers-reduced-motion: reduce)',
  );

  if (!open) {
    return null;
  }

  const { background, foreground } = SEVERITY_COLORS[severity];

  return (
    <Slide
      appear
      direction="up"
      in
      timeout={prefersReducedMotion ? 0 : SLIDE_DURATION_MS}
    >
      <Box
        // Time-sensitive: a captioning tool's user needs to know *now* that
        // captions may have stopped, so this is `role="alert"` (implicit
        // aria-live="assertive", no extra aria-live attribute needed) rather
        // than the polite `role="status"` used elsewhere for non-urgent live
        // regions. Non-blocking though — no focus move, unlike
        // MainErrorFallback's full-page block. SC 4.1.3
        role="alert"
        sx={{
          position: 'fixed',
          bottom: 0,
          insetInline: 0,
          zIndex: (theme) => theme.zIndex.snackbar,
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          px: 2,
          py: 1.5,
          backgroundColor: background,
          color: foreground,
        }}
      >
        {/* Icon shape (not just color) distinguishes severity, and the icon
            is aria-hidden since the adjacent `message` text already carries
            the meaning for screen-reader users — never convey status by
            icon/color alone. SC 1.4.1 */}
        {severity === 'warning' ? (
          <WarningAmberIcon
            aria-hidden="true"
            sx={{ color: foreground, flexShrink: 0 }}
          />
        ) : (
          <ErrorOutlineIcon
            aria-hidden="true"
            sx={{ color: foreground, flexShrink: 0 }}
          />
        )}
        <Typography sx={{ color: foreground }}>{message}</Typography>
      </Box>
    </Slide>
  );
};
