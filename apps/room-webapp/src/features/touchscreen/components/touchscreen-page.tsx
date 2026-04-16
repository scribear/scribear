import { RoomServiceStatus } from '#src/features/room-provider/services/room-service-status';
import { selectRoomServiceStatus } from '#src/features/room-provider/stores/room-service-slice';
import { useAppSelector } from '#src/store/use-redux';
import { ActivationView } from './activation-view';
import { HomeDisplay } from './home-display';

export const TouchscreenPage = () => {
  const status = useAppSelector(selectRoomServiceStatus);

  const isNotActivated =
    status === RoomServiceStatus.INACTIVE ||
    status === RoomServiceStatus.NOT_REGISTERED ||
    status === RoomServiceStatus.REGISTERING ||
    status === RoomServiceStatus.REGISTRATION_ERROR;

  return isNotActivated ? <ActivationView /> : <HomeDisplay />;
};
