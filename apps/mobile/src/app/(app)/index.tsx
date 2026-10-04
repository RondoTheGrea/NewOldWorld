import { SymbolView } from 'expo-symbols';
import { useState } from 'react';
import { Alert, Pressable, StyleSheet, View } from 'react-native';

import { EndDayCard } from '@/components/end-day-card';
import { ErrorBoundary } from '@/components/error-boundary';
import { ExpensesCard } from '@/components/expenses-card';
import { PrinterCard } from '@/components/printer-card';
import { RunHistoryCard } from '@/components/run-history-card';
import { Screen } from '@/components/screen';
import { SettingsModal } from '@/components/settings-modal';
import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useAuth } from '@/context/auth';
import { useInventory } from '@/context/inventory';
import { useTheme } from '@/hooks/use-theme';
import { runWithRetry } from '@/lib/retry';

// Boundary per tab, so a crash here can't take the rest of the app with it.
export default function HomeScreen() {
  return (
    <ErrorBoundary label="Home">
      <HomeScreenContent />
    </ErrorBoundary>
  );
}

function HomeScreenContent() {
  const { user, signOut } = useAuth();
  const { setup } = useInventory();
  const theme = useTheme();
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Signing out clears Firebase's saved session on disk, which can fail. Left
  // bare it would look like the button simply did nothing.
  async function handleSignOut() {
    // Refused while a run is open, and this one is not politeness — it is the
    // difference between a working day and an unfinishable one.
    //
    // Logging out does not end a run: the setup survives it, so a second
    // account signing in inherits the first one's open run. Every upload from
    // that run is stamped `createdByUid` = the account that *started* it, and
    // firestore.rules requires that field to equal the signed-in uid — so under
    // the new account every receipt, ledger entry and the closing write itself
    // are rejected, permanently, by a rule no retry can satisfy. Since "End the
    // Day" now refuses to close while anything is unsent, the day could never
    // be finished at all.
    //
    // Blocking the swap is the cheap fix. The alternatives are worse: stamping
    // uploads with whoever is signed in *now* makes the run's owner drift
    // mid-day, and relaxing the rule gives up the one check that says a phone
    // may only write its own work. There is no in-app escape hatch from an
    // abandoned run right now: Settings' "Reset truck setup" was it, and that
    // row is a developer-testing one that is currently removed.
    if (setup.complete) {
      Alert.alert(
        'End the day first',
        'Today’s work is filed under the account that started it. Logging out now would stop anything else from today reaching the server.\n\nEnd the day, then log out.',
        [{ text: 'OK' }],
      );
      return;
    }

    await runWithRetry(() => signOut(), {
      scope: 'auth.signOut',
      title: 'Could not log out',
      message: 'You’re still signed in on this phone.',
    });
  }

  return (
    // Scrolls: the cards below stack up (printer, run history, expenses, end
    // the day) and on a short screen the last one used to be cut off with no
    // way to reach it.
    <Screen scroll>
      <View style={styles.topBar}>
        <ThemedText
          type="small"
          themeColor="textSecondary"
          numberOfLines={1}
          style={styles.email}
          // Keeps a long email from squeezing the buttons off-screen.
          ellipsizeMode="middle">
          {user?.email ?? ''}
        </ThemedText>

        <View style={styles.topBarButtons}>
          <Pressable
            onPress={() => setSettingsOpen(true)}
            accessibilityRole="button"
            accessibilityLabel="Settings"
            style={({ pressed }) => [
              styles.iconButton,
              { borderColor: theme.textSecondary, opacity: pressed ? 0.7 : 1 },
            ]}>
            <SymbolView
              name={{ ios: 'gearshape', android: 'settings', web: 'settings' }}
              tintColor={theme.text}
              size={18}
            />
          </Pressable>

          <Pressable
            onPress={handleSignOut}
            accessibilityRole="button"
            style={({ pressed }) => [
              styles.logoutButton,
              { borderColor: theme.textSecondary, opacity: pressed ? 0.7 : 1 },
            ]}>
            <ThemedText type="smallBold">Log out</ThemedText>
          </Pressable>
        </View>
      </View>

      <PrinterCard />

      <RunHistoryCard />

      {/* Breakdown & Expenses. Above "End the day", because it is something the
          driver adds to during the trip and that one is what finishes it. */}
      <ExpensesCard />

      <EndDayCard />

      {/* Blank below the cards on purpose — the rest of the POS home screen goes here. */}

      <SettingsModal visible={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.three,
  },
  email: {
    flexShrink: 1,
  },
  topBarButtons: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  iconButton: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: Spacing.two,
    padding: Spacing.two,
  },
  logoutButton: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: Spacing.two,
    paddingVertical: Spacing.two,
    paddingHorizontal: Spacing.three,
  },
});
