import { Navigate, Route, Routes } from 'react-router-dom';

import { AppLayout } from '#src/components/app-layout';
import { RequireAuth } from '#src/components/require-auth';
import { AuditPage } from '#src/features/audit/audit-page';
import { LoginPage } from '#src/features/auth/login-page';
import { DashboardPage } from '#src/features/dashboard/dashboard-page';
import { DeviceDetailPage } from '#src/features/devices/device-detail-page';
import { DevicesListPage } from '#src/features/devices/devices-list-page';
import { KioskWizardPage } from '#src/features/kiosk-setup/kiosk-wizard-page';
import { RoomDetailPage } from '#src/features/rooms/room-detail-page';
import { RoomsListPage } from '#src/features/rooms/rooms-list-page';
import { RoomSchedulingPage } from '#src/features/scheduling/room-scheduling-page';
import { SessionDetailPage } from '#src/features/sessions/session-detail-page';

export const AppRoutes = () => (
  <Routes>
    <Route path="/login" element={<LoginPage />} />
    <Route element={<RequireAuth />}>
      <Route element={<AppLayout />}>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/rooms" element={<RoomsListPage />} />
        <Route path="/rooms/:roomUid" element={<RoomDetailPage />} />
        <Route
          path="/rooms/:roomUid/scheduling"
          element={<RoomSchedulingPage />}
        />
        <Route path="/devices" element={<DevicesListPage />} />
        <Route path="/devices/:deviceUid" element={<DeviceDetailPage />} />
        <Route path="/sessions/:sessionUid" element={<SessionDetailPage />} />
        <Route path="/kiosk-setup" element={<KioskWizardPage />} />
        <Route path="/audit" element={<AuditPage />} />
      </Route>
    </Route>
    <Route path="*" element={<Navigate to="/" replace />} />
  </Routes>
);
