import { useState } from 'react';

import Typography from '@mui/material/Typography';

import { CancelableInfoModal } from '#src/components/ui/cancelable-info-modal';

import { getUrlConfigErrors } from '../url-fragment-driver';

export const UrlConfigErrorModal = () => {
  const errors = getUrlConfigErrors();
  const [isOpen, setIsOpen] = useState(errors !== null);

  if (!errors) return null;

  return (
    <CancelableInfoModal
      isOpen={isOpen}
      message="Invalid URL configuration"
      onCancel={() => setIsOpen(false)}
    >
      <Typography variant="body2" component="ul" sx={{ pl: 2 }}>
        {errors.map((error) => (
          <li key={error}>{error}</li>
        ))}
      </Typography>
    </CancelableInfoModal>
  );
};
