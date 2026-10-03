import Constants from 'expo-constants';
import { SymbolView, type SymbolViewProps } from 'expo-symbols';
import { useState } from 'react';
import { Modal, Pressable, StyleSheet, View } from 'react-native';

import { NoticeDialog } from '@/components/notice-dialog';
import { ThemedText } from '@/components/themed-text';
import { MaxContentWidth, Spacing } from '@/constants/theme';
import { describeSyncCounts, useSync } from '@/context/sync';
import { useTheme } from '@/hooks/use-theme';
import { checkAppCheckStatus, type AppCheckVerdict } from '@/lib/app-check-status';
import { runWithRetry } from '@/lib/retry';

type SettingsModalProps = {
  visible: boolean;
  onClose: () => void;
};

const appVersion = Constants.expoConfig?.version ?? '—';
const versionCode = Constants.expoConfig?.android?.versionCode ?? '—';

/**
 * One place for app-wide maintenance actions instead of scattering buttons
 * across tabs. Add new rows to the list below as new actions are needed.
 */
export function SettingsModal({ visible, onClose }: SettingsModalProps) {
  const theme = useTheme();
  const { synced, blocked, retryBlocked } = useSync();
  // What the retry queued, held until the notice is dismissed. The settings
  // sheet stays open behind it: this dialog is rendered inside that Modal, so
  // closing first would unmount the very thing it's reporting.
  const [queuedAgain, setQueuedAgain] = useState<number | null>(null);
  // The App Check answer, held until dismissed. Unlike the retry notice above,
  // dismissing this one leaves the sheet open: it reports nothing that changed,
  // and the usual next move is to run it again on another phone or after
  // moving somewhere with better signal.
  const [verdict, setVerdict] = useState<AppCheckVerdict | null>(null);
  const [checking, setChecking] = useState(false);

  /**
   * Re-queues records the server refused.
   *
   * No confirmation step: this takes nothing away. The worst case is that the
   * server refuses them again and they go back where they were.
   */
  async function handleRetryBlocked() {
    const result = await runWithRetry(() => retryBlocked(), {
      scope: 'settings.retryBlocked',
      title: 'Could not queue those records',
      message: 'Nothing changed — they are still saved on this phone and still marked as refused.',
    });
    if (!result.completed) return;

    // Sending happens in the background, so the confirmation is about the
    // queue, not about the server having them: promising delivery here would
    // be a promise this phone can't keep from inside a dead zone. The sheet
    // is closed by the notice, not before it.
    setQueuedAgain(result.value);
  }

  /**
   * "Can this phone prove it's a real one?" — see `lib/app-check-status.ts`.
   *
   * A read, not a write: nothing is sent, queued or changed, which is why the
   * failure message says so. Re-entry is guarded because the call can take a
   * few seconds against a cold function and the row gives no other sign that a
   * tap landed.
   */
  async function handleCheckAppCheck() {
    if (checking) return;
    setChecking(true);
    const result = await runWithRetry(() => checkAppCheckStatus(), {
      scope: 'settings.appCheckStatus',
      title: 'Could not check this phone',
      message: 'Nothing was changed or sent — this row only reads a status.',
    });
    setChecking(false);
    if (!result.completed) return;
    setVerdict(result.value);
  }

  // Worded once and read three times below, so the title, body and footnote
  // can't come from three separate calls that drift apart.
  const verdictNotice = verdict ? describeVerdict(verdict) : null;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable onPress={() => {}} style={styles.wrapper}>
          <View style={[styles.card, { backgroundColor: theme.background }]}>
            <View style={styles.header}>
              <ThemedText type="subtitle" style={styles.title}>
                Settings
              </ThemedText>
              <Pressable
                onPress={onClose}
                accessibilityRole="button"
                accessibilityLabel="Close"
                hitSlop={Spacing.two}
                style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}>
                <SymbolView
                  name={{ ios: 'xmark', android: 'close', web: 'close' }}
                  tintColor={theme.text}
                  size={24}
                />
              </Pressable>
            </View>

            <View style={[styles.divider, { backgroundColor: theme.border }]} />

            {/* Only once this phone has actually tried sending something — a
                fresh install with nothing uploaded yet has nothing to report. */}
            {synced.total + blocked.total > 0 ? <SyncHealthCard synced={synced.total} blocked={blocked.total} /> : null}

            <View style={styles.rows}>
              {/* A developer row, in the sense CLAUDE.md gives the term: it is
                  here to be tapped once on each real handset before App Check
                  enforcement is switched on in the Firebase console, and can go
                  again afterwards. It is the only place that answers the
                  question per-phone — the console's percentage counts every
                  request naming this app's id, bots included. */}
              <SettingsRow
                icon={{ ios: 'checkmark.shield', android: 'verified_user', web: 'verified_user' }}
                label={checking ? 'Checking this phone…' : "Check this phone's security token"}
                description="Asks the server whether this phone's requests arrive proving they came from a genuine copy of the app."
                onPress={() => void handleCheckAppCheck()}
              />

              {/* Only when there is something to retry. Its appearing is
                  itself the signal that a record needs attention. */}
              {blocked.total > 0 ? (
                <SettingsRow
                  icon={{ ios: 'arrow.clockwise.icloud', android: 'cloud_sync', web: 'cloud_sync' }}
                  label="Try sending refused records again"
                  description={`The server refused ${describeSyncCounts(blocked)}. Common cause: they were recorded by a different agent — sign in as them, then retry.`}
                  onPress={() => void handleRetryBlocked()}
                />
              ) : null}
            </View>

            <ThemedText type="small" themeColor="textSecondary" style={styles.version}>
              Version {appVersion} ({versionCode})
            </ThemedText>
          </View>
        </Pressable>
      </Pressable>

      <NoticeDialog
        visible={queuedAgain !== null}
        title="Queued again"
        message={
          queuedAgain && queuedAgain > 0
            ? `${queuedAgain} ${queuedAgain === 1 ? 'record' : 'records'} will be sent again. Check “Today’s upload” on the Home tab to see them go.`
            : 'There was nothing left to retry.'
        }
        onClose={() => {
          setQueuedAgain(null);
          onClose();
        }}
      />

      <NoticeDialog
        visible={verdictNotice !== null}
        title={verdictNotice?.title ?? ''}
        message={verdictNotice?.message}
        footnote={verdictNotice?.footnote}
        onClose={() => setVerdict(null)}
      />
    </Modal>
  );
}

/**
 * One wording per verdict, in the driver's terms rather than Firebase's.
 *
 * Two of the four are deliberately not phrased as failures. "App Check isn't
 * running here" and "the emulators don't check" both produce no token, and a
 * healthy phone reported as untrustworthy is the false alarm this whole row
 * exists to remove — the console's mixed-in bot traffic being the other one.
 */
function describeVerdict(verdict: AppCheckVerdict): {
  title: string;
  message: string;
  footnote?: string;
} {
  switch (verdict.kind) {
    case 'verified':
      return {
        title: 'Verified',
        message:
          "Google checked this phone's request and confirmed it came from a genuine, unmodified copy of this app. Turning on App Check enforcement will not lock this phone out.",
        footnote: verdict.appId ? `App: ${verdict.appId}` : undefined,
      };
    case 'unverified':
      // Two genuinely different faults, and telling them apart is the whole
      // reason the probe runs. A phone that cannot mint a token is a device or
      // Play problem; one that mints a token the server still won't accept is a
      // registration problem, and sending someone outside to find signal over
      // the second would waste their morning.
      // Throttled is its own case and reads the opposite way to the other two:
      // Play only rate-limits a request it accepted from an app it recognises,
      // so it is confirmation the setup works, not a fault to go and hunt.
      if (verdict.throttled) {
        return {
          title: 'Checked too often',
          message:
            "Google Play recognised this app but is briefly refusing more checks, because it has been asked too many times in a row. That means the setup is right — nothing needs fixing. Leave it a few minutes and check again.",
          footnote: `Reported by the Play Integrity check: ${verdict.reason ?? ''}`,
        };
      }
      return verdict.reason
        ? {
            title: 'Not verified',
            message:
              'This phone could not produce a security token, so its requests arrive unproven. If enforcement were switched on, the server would refuse them.',
            footnote: `Reported by the Play Integrity check: ${verdict.reason}`,
          }
        : {
            title: 'Not verified',
            message:
              'This phone can produce a security token, but the server did not accept the one it sent. That points at how the app is registered rather than at this handset — the signing certificate or the Play link, not the signal.',
          };
    case 'not-running':
      return {
        title: 'Not checked on this phone',
        message:
          'The security check does not run on this phone, so there is no token to test. That is expected on an iPhone, or on a build put together without the Google services file.',
      };
    case 'no-verdict-locally':
      return {
        title: 'No answer while testing',
        message:
          'This phone is pointed at the test backend on your computer, which does not check security tokens at all. Run this on a copy installed from Google Play to get a real answer.',
      };
  }
}

function SettingsRow({
  icon,
  label,
  description,
  destructive,
  onPress,
}: {
  icon: SymbolViewProps['name'];
  label: string;
  description: string;
  destructive?: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.row, { backgroundColor: pressed ? theme.backgroundElement : 'transparent' }]}>
      <SymbolView name={icon} tintColor={destructive ? '#e5484d' : theme.text} size={20} />
      <View style={styles.rowText}>
        <ThemedText type="smallBold" style={destructive ? styles.error : undefined}>
          {label}
        </ThemedText>
        <ThemedText type="small" themeColor="textSecondary">
          {description}
        </ThemedText>
      </View>
    </Pressable>
  );
}

/**
 * "How many of this phone's uploads has the server actually confirmed" —
 * every `'synced'` row against every `'blocked'` one, for the life of the
 * install (see SyncSynced / SyncBlocked in context/sync.tsx).
 *
 * Deliberately doesn't count `pending`: a queued row isn't a verification
 * outcome yet, it's still in flight, so folding it in here would make the bar
 * shrink and grow as normal upload traffic moves through rather than only
 * when something is actually refused.
 */
function SyncHealthCard({ synced, blocked }: { synced: number; blocked: number }) {
  const theme = useTheme();
  const total = synced + blocked;
  const verifiedShare = total > 0 ? synced / total : 1;
  const verifiedPercent = Math.round(verifiedShare * 100);

  return (
    <View style={styles.syncHealth}>
      <ThemedText type="smallBold">Uploads to the server</ThemedText>
      <View style={[styles.syncHealthBar, { backgroundColor: theme.backgroundElement }]}>
        <View style={[styles.syncHealthSegment, { flex: verifiedShare, backgroundColor: theme.success }]} />
        {blocked > 0 ? (
          <View style={[styles.syncHealthSegment, { flex: 1 - verifiedShare, backgroundColor: theme.danger }]} />
        ) : null}
      </View>
      <View style={styles.syncHealthLegend}>
        <SyncHealthKey color={theme.success} label={`${synced.toLocaleString()} verified`} />
        <SyncHealthKey color={theme.danger} label={`${blocked.toLocaleString()} refused`} />
      </View>
      <ThemedText type="small" themeColor="textSecondary">
        {blocked > 0
          ? `${verifiedPercent}% of everything this phone has sent has reached the server.`
          : 'Everything this phone has sent has reached the server.'}
      </ThemedText>
    </View>
  );
}

function SyncHealthKey({ color, label }: { color: string; label: string }) {
  return (
    <View style={styles.syncHealthKey}>
      <View style={[styles.syncHealthDot, { backgroundColor: color }]} />
      <ThemedText type="small">{label}</ThemedText>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.4)',
    padding: Spacing.four,
  },
  wrapper: {
    width: '100%',
    maxWidth: MaxContentWidth,
  },
  card: {
    borderRadius: Spacing.four,
    padding: Spacing.four,
    gap: Spacing.three,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.two,
  },
  title: {
    flex: 1,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
  },
  syncHealth: {
    gap: Spacing.two,
  },
  syncHealthBar: {
    flexDirection: 'row',
    height: 10,
    borderRadius: Spacing.one,
    overflow: 'hidden',
  },
  syncHealthSegment: {
    height: '100%',
  },
  syncHealthLegend: {
    flexDirection: 'row',
    gap: Spacing.three,
  },
  syncHealthKey: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
  },
  syncHealthDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  rows: {
    gap: Spacing.one,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.two,
    padding: Spacing.two,
    borderRadius: Spacing.two,
  },
  rowText: {
    flex: 1,
    gap: Spacing.half,
  },
  error: {
    color: '#e5484d',
  },
  version: {
    textAlign: 'center',
  },
});
