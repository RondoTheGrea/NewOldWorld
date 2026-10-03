import { DefaultTheme, Stack, ThemeProvider, type Theme } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect } from 'react';
import { StatusBar, StyleSheet } from 'react-native';

import { ErrorBoundary } from '@/components/error-boundary';
import { Colors } from '@/constants/theme';
import { AuthProvider, useAuth } from '@/context/auth';

SplashScreen.preventAutoHideAsync();

// The app is white-only, so the navigator's own surfaces (the gap behind a
// screen during a push, modal backdrops) are painted white too. Left on the
// stock theme they default to a light grey that shows through at the edges.
const navigationTheme: Theme = {
  ...DefaultTheme,
  colors: {
    ...DefaultTheme.colors,
    background: Colors.background,
    card: Colors.background,
    text: Colors.text,
    border: Colors.border,
  },
};

function RootNavigator() {
  const { user, initializing } = useAuth();

  // Hold the splash screen until Firebase has restored any saved login, then
  // hand over to the first real screen. Doing it here (rather than in a
  // component that may not mount) means there is exactly one place the splash
  // can be dismissed from, so the app can't get stuck on it.
  useEffect(() => {
    if (!initializing) {
      SplashScreen.hideAsync().catch(() => {
        // Already hidden — nothing to do.
      });
    }
  }, [initializing]);

  // An already-logged-in user never flashes the login screen on launch.
  if (initializing) {
    return null;
  }

  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: styles.screen }}>
      {/* Logged in: the POS app. */}
      <Stack.Protected guard={!!user}>
        <Stack.Screen name="(app)" />
      </Stack.Protected>

      {/* Logged out: only the auth screens are reachable. */}
      <Stack.Protected guard={!user}>
        <Stack.Screen name="sign-in" />
        <Stack.Screen name="sign-up" />
      </Stack.Protected>
    </Stack>
  );
}

export default function RootLayout() {
  return (
    // The outermost net: anything that crashes while rendering — a provider, a
    // navigator, a screen with no boundary of its own — lands here and shows a
    // recoverable message instead of a blank white app. Individual tabs have
    // their own boundaries so they fail without taking the tab bar with them.
    <ErrorBoundary label="The app">
      <AuthProvider>
        <ThemeProvider value={navigationTheme}>
          {/* Dark icons, because the bar sits on white. */}
          <StatusBar barStyle="dark-content" />
          <RootNavigator />
        </ThemeProvider>
      </AuthProvider>
    </ErrorBoundary>
  );
}

const styles = StyleSheet.create({
  screen: {
    backgroundColor: Colors.background,
  },
});
