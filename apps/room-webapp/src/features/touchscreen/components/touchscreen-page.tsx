import { MicrophoneModal } from '@scribear/microphone-ui';
import {
  activateMicrophone,
  deactivateMicrophone,
  selectMicrophoneServiceStatus,
} from '@scribear/microphone-store';

import { RoomServiceStatus } from '#src/features/room-provider/services/room-service-status';
import { selectDeviceId, selectSessionRefreshToken } from '#src/features/room-provider/stores/room-config-slice';
import { selectRoomServiceStatus } from '#src/features/room-provider/stores/room-service-slice';
import { useAppDispatch, useAppSelector } from '#src/store/use-redux';
import { ActivationView } from './activation-view';
import { HomeDisplay } from './home-display';

export const TouchscreenPage = () => {
  const dispatch = useAppDispatch();
  const status = useAppSelector(selectRoomServiceStatus);
  const deviceId = useAppSelector(selectDeviceId);
  const sessionRefreshToken = useAppSelector(selectSessionRefreshToken);
  const microphoneServiceStatus = useAppSelector(selectMicrophoneServiceStatus);

  const hasRegistration = Boolean(deviceId || sessionRefreshToken);

  const isNotActivated =
    !hasRegistration &&
    (status === RoomServiceStatus.INACTIVE ||
      status === RoomServiceStatus.NOT_REGISTERED ||
      status === RoomServiceStatus.REGISTERING ||
      status === RoomServiceStatus.REGISTRATION_ERROR);

  return (
    <>
      <MicrophoneModal
        microphoneServiceStatus={microphoneServiceStatus}
        activate={() => void dispatch(activateMicrophone())}
        deactivate={() => dispatch(deactivateMicrophone())}
      />
      {isNotActivated ? <ActivationView /> : <HomeDisplay />}
    </>
  );
};
