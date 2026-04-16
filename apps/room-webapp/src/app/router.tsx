import { Navigate, RouterProvider, createBrowserRouter } from 'react-router-dom';

import { DisplayPage } from '#src/features/display/components/display-page';
import { TouchscreenPage } from '#src/features/touchscreen/components/touchscreen-page';

const router = createBrowserRouter([
  { path: '/', element: <Navigate to="/touchscreen" replace /> },
  { path: '/touchscreen', element: <TouchscreenPage /> },
  { path: '/display', element: <DisplayPage /> },
]);

export const AppRouter = () => <RouterProvider router={router} />;
