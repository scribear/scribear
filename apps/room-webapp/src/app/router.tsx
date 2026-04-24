import { Navigate, RouterProvider, createBrowserRouter } from 'react-router-dom';

import { DisplayPage } from '#src/features/display/components/display-page';
import { TouchscreenPage } from '#src/features/touchscreen/components/touchscreen-page';
import { WallPanelPage } from '#src/features/wall-panel/components/wall-panel-page';

const router = createBrowserRouter([
  { path: '/', element: <Navigate to="/touchscreen" replace /> },
  { path: '/touchscreen', element: <TouchscreenPage /> },
  { path: '/display', element: <DisplayPage /> },
  { path: '/wall-panel', element: <WallPanelPage /> },
]);

export const AppRouter = () => <RouterProvider router={router} />;
