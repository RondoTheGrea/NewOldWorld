import { DashboardShell } from '@/components/dashboard-shell';
import { AuthProvider, useAuth } from '@/context/auth';
import { LoginPage } from '@/pages/login';

function AuthGate() {
  const { user, initializing } = useAuth();

  if (initializing) {
    // Firebase is checking for a saved session; render nothing rather than
    // flashing the login screen for users who are already signed in.
    return null;
  }

  return user ? <DashboardShell /> : <LoginPage />;
}

function App() {
  return (
    <AuthProvider>
      <AuthGate />
    </AuthProvider>
  );
}

export default App;
