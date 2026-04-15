import { Navigate, Route, Routes } from 'react-router-dom';

import { AppProvider } from './app-provider';
import { DisplayRoot } from './display-root';
import { HostRoot } from './host-root';

export const App = () => {
  return (
    <AppProvider>
      <Routes>
        <Route path="/host" element={<HostRoot />} />
        <Route path="/display" element={<DisplayRoot />} />
        <Route path="/" element={<Navigate to="/host" replace />} />
        <Route path="*" element={<Navigate to="/host" replace />} />
      </Routes>
    </AppProvider>
  );
};
