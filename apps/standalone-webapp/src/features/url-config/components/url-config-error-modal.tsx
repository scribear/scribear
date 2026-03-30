import { useState } from 'react';

import Typography from '@mui/material/Typography';

import { CancelableInfoModal } from '@scribear/core-ui';

import { getUrlConfigErrors } from '../url-fragment-driver';

/**
 * Displays a dismissible modal listing validation errors found in the URL
 * fragment config. Renders nothing when there are no errors.
 */
export const UrlConfigErrorModal = () => {
  const errors = getUrlConfigErrors();
  const [isOpen, setIsOpen] = useState(errors !== null);

  if (!errors) return null;

  return (
    <CancelableInfoModal
      isOpen={isOpen}
      message="Invalid URL configuration"
      onCancel={() => {
        setIsOpen(false);
      }}
    >
      <Typography variant="body2" component="ul" sx={{ pl: 2 }}>
        {errors.map((error) => (
          <li key={error}>{error}</li>
        ))}
      </Typography>
    </CancelableInfoModal>
  );
};
