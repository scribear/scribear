/**
 * Custom link component for utilizing MUI style and react router
 */
import Link from '@mui/material/Link';

import { Link as ReactRouterLink } from 'react-router';

interface AppLinkProps {
  children?: React.ReactNode;
  to: string;
}

export const AppLink = ({ children, to }: AppLinkProps) => {
  return (
    <Link component={ReactRouterLink} to={to}>
      {children}
    </Link>
  );
};
