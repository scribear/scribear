import { Navigate, createBrowserRouter, RouterProvider } from 'react-router-dom';

// Placeholder pages - will be replaced in later tasks
const TouchscreenPage = () => <div>Touchscreen</div>;
const DisplayPage = () => <div>Display</div>;

const router = createBrowserRouter([
  { path: '/', element: <Navigate to="/touchscreen" replace /> },
  { path: '/touchscreen', element: <TouchscreenPage /> },
  { path: '/display', element: <DisplayPage /> },
]);

export const AppRouter = () => <RouterProvider router={router} />;
