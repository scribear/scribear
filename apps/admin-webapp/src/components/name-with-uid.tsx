import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';

interface NameWithUidProps {
  name: React.ReactNode;
  uid: string;
  showUid: boolean;
}

/**
 * Renders a display name, with the entity's UUID shown underneath in muted
 * monospace whenever the "Show UUIDs" setting is on.
 */
export const NameWithUid = ({ name, uid, showUid }: NameWithUidProps) => {
  if (!showUid) return <>{name}</>;
  return (
    <Box>
      <Box>{name}</Box>
      <Typography
        variant="caption"
        sx={{
          color: 'text.secondary',
          fontFamily: 'monospace',
          display: 'block',
        }}
      >
        {uid}
      </Typography>
    </Box>
  );
};
