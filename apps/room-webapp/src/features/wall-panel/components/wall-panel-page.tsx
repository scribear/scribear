import {
  activateMicrophone,
  deactivateMicrophone,
  selectMicrophoneServiceStatus,
} from '@scribear/microphone-store';
import { MicrophoneModal } from '@scribear/microphone-ui';

import { RoomServiceStatus } from '#src/features/room-provider/services/room-service-status';
import {
  selectDeviceId,
  selectSessionRefreshToken,
} from '#src/features/room-provider/stores/room-config-slice';
import { selectRoomServiceStatus } from '#src/features/room-provider/stores/room-service-slice';
import { ActivationView } from '#src/features/touchscreen/components/activation-view';
import { useAppDispatch, useAppSelector } from '#src/store/use-redux';

import { WallPanelHome } from './wall-panel-home';

export const WallPanelPage = () => {
  const dispatch = useAppDispatch();
  const status = useAppSelector(selectRoomServiceStatus);
  const deviceId = useAppSelector(selectDeviceId);
  const sessionRefreshToken = useAppSelector(selectSessionRefreshToken);
  const microphoneServiceStatus = useAppSelector(selectMicrophoneServiceStatus);

  const hasRegistration = Boolean(deviceId ?? sessionRefreshToken);

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
      {isNotActivated ? <ActivationView /> : <WallPanelHome />}
    </>
  );
};
