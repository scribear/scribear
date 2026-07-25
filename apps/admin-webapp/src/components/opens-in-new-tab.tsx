import Box from '@mui/material/Box';

/**
 * The standard visually-hidden recipe: removed from the visual layout but still
 * in the accessibility tree (unlike `display: none` or `visibility: hidden`).
 * Inlined rather than imported from `@mui/utils`, which is only a transitive
 * dependency here.
 */
const VISUALLY_HIDDEN = {
  position: 'absolute',
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
  border: 0,
} as const;

/**
 * Visually-hidden "(opens in a new tab)" suffix for links that set
 * `target="_blank"`.
 *
 * WCAG SC 3.2.5 (Change on Request): a link that opens a new window has to say
 * so in its accessible name, not only through an adjacent icon — the
 * `OpenInNewIcon` beside these links is decorative and carries no text
 * alternative. Placed *inside* the anchor/button so it lands in the computed
 * accessible name.
 */
export const OpensInNewTab = () => (
  <Box component="span" sx={VISUALLY_HIDDEN}>
    (opens in a new tab)
  </Box>
);
