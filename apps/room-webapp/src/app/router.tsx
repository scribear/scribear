import { Navigate, RouterProvider, createBrowserRouter } from 'react-router-dom';
import { TouchscreenPage } from '#src/features/touchscreen/components/touchscreen-page';

const DisplayPage = () => <div>Display (coming soon)</div>;

const router = createBrowserRouter([
  { path: '/', element: <Navigate to="/touchscreen" replace /> },
  { path: '/touchscreen', element: <TouchscreenPage /> },
  { path: '/display', element: <DisplayPage /> },
]);

export const AppRouter = () => <RouterProvider router={router} />;
