import { selectDeviceName } from '#src/features/room-provider/stores/room-config-slice';
import { selectActiveSessionId } from '#src/features/room-provider/stores/room-config-slice';
import { useAppSelector } from '#src/store/use-redux';

import { DisplayIdle } from './display-idle';
import { DisplayLive } from './display-live';
import { DisplayNotActivated } from './display-not-activated';

export const DisplayPage = () => {
  const deviceName = useAppSelector(selectDeviceName);
  const activeSessionId = useAppSelector(selectActiveSessionId);

  if (!deviceName) {
    return <DisplayNotActivated />;
  }

  if (activeSessionId) {
    return <DisplayLive />;
  }

  return <DisplayIdle />;
};
