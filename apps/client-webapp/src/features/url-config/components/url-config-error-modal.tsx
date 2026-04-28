import Typography from '@mui/material/Typography';

import { CancelableInfoModal } from '@scribear/core-ui';
import {
  clearUrlConfigErrors,
  selectUrlConfigErrors,
} from '@scribear/url-config-store';

import { useAppDispatch, useAppSelector } from '#src/store/use-redux';

/**
 * Displays a dismissible modal listing validation errors found in the URL
 * fragment config. Renders nothing when there are no errors.
 */
export const UrlConfigErrorModal = () => {
  const dispatch = useAppDispatch();
  const errors = useAppSelector(selectUrlConfigErrors);

  if (!errors) return null;

  return (
    <CancelableInfoModal
      isOpen={true}
      message="Invalid URL configuration"
      onCancel={() => {
        dispatch(clearUrlConfigErrors());
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
