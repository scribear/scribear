import { configureStore } from '@reduxjs/toolkit';
import { render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import { describe, expect, it } from 'vitest';

import { JoinSessionModal } from '#src/features/session-provider/components/join-session-modal';
import {
  ClientLifecycle,
  JoinError,
  JoinNotice,
} from '#src/features/session-provider/services/client-session-service-status';
import {
  setJoinError,
  setJoinNotice,
  setLifecycle,
} from '#src/features/session-provider/stores/client-session-service-slice';
import { rootReducer } from '#src/store/store';

/**
 * Render the dialog over a real store, in `IDLE` (the only lifecycle that
 * opens it), with whatever join error/notice the case is about. No service
 * middleware: this is about what the dialog says, not how the state got there.
 */
function renderIdleDialog(options: {
  joinNotice?: JoinNotice;
  joinError?: JoinError;
}) {
  const store = configureStore({ reducer: rootReducer });
  store.dispatch(setLifecycle(ClientLifecycle.IDLE));
  if (options.joinNotice !== undefined) {
    store.dispatch(setJoinNotice(options.joinNotice));
  }
  if (options.joinError !== undefined) {
    store.dispatch(setJoinError(options.joinError));
  }
  render(
    <Provider store={store}>
      <JoinSessionModal />
    </Provider>,
  );
}

describe('JoinSessionModal', () => {
  it('explains a session that ended, rather than reopening blank', () => {
    renderIdleDialog({ joinNotice: JoinNotice.SESSION_ENDED });

    // The whole point of the notice: a viewer whose captions just vanished
    // must be able to read why on the dialog that replaced them.
    expect(screen.getByText(/This session has ended\./)).toBeInTheDocument();
  });

  it('states it informationally, not as something the viewer broke', () => {
    renderIdleDialog({ joinNotice: JoinNotice.SESSION_ENDED });

    // `info` = expected, no action - a session ending on schedule is not a
    // fault, and must not paint the join field red.
    const alerts = screen.getAllByRole('alert');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.className).toContain('MuiAlert-colorInfo');
    expect(alerts[0]?.className).not.toContain('MuiAlert-colorError');
    expect(screen.getByLabelText('Join Code')).not.toHaveAttribute(
      'aria-invalid',
      'true',
    );
  });

  it('describes the dialog with the notice, so it is announced on open', () => {
    renderIdleDialog({ joinNotice: JoinNotice.SESSION_ENDED });

    const dialog = screen.getByRole('dialog');
    const describedBy = dialog.getAttribute('aria-describedby');
    expect(describedBy).not.toBeNull();
    expect(document.getElementById(describedBy ?? '')).toHaveTextContent(
      /This session has ended\./,
    );
  });

  it('shows nothing extra when the dialog opens for any other reason', () => {
    renderIdleDialog({});

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('dialog')).not.toHaveAttribute('aria-describedby');
  });

  it('leaves a failed join attempt reading as an error', () => {
    renderIdleDialog({ joinError: JoinError.JOIN_CODE_NOT_FOUND });

    // Unchanged behaviour: the notice is a separate, additive surface and
    // must not have softened or displaced the existing failure messaging.
    const alerts = screen.getAllByRole('alert');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toHaveTextContent('Invalid join code. Please try again.');
    expect(alerts[0]?.className).toContain('MuiAlert-colorError');
    expect(screen.getByLabelText('Join Code')).toHaveAttribute(
      'aria-invalid',
      'true',
    );
  });
});
