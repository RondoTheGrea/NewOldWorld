import { SymbolView } from 'expo-symbols';
import { useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  type LayoutChangeEvent,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  View,
} from 'react-native';
import { ThemedText } from '@/components/themed-text';
import { MaxContentWidth, Spacing } from '@/constants/theme';
import { usePrinter } from '@/context/printer';
import { useTheme } from '@/hooks/use-theme';
import { logError } from '@/lib/errors';
import {
  ensureConnectPermission,
  isBluetoothEnabled,
  requestBluetoothEnabled,
  waitForBluetoothEnabled,
  type PrinterDevice,
} from '@/lib/printer';
import { runWithRetry } from '@/lib/retry';

// A recent-device row's height, derived from its own style (not guessed):
// DeviceRow's vertical padding plus a "default" ThemedText's line height.
const RECENT_ROW_HEIGHT = Spacing.two * 2 + 24;
const VISIBLE_RECENT_ROWS = 3;
const FAVORITE_COLOR = '#f5a524';

/**
 * Receipt printer status + connection UI for the Home tab. Android only —
 * generic ESC/POS printers use classic Bluetooth, which iOS only allows for
 * Apple MFi-certified accessories. Renders nothing on iOS rather than
 * showing a button that can never work there.
 */
export function PrinterCard() {
  if (Platform.OS !== 'android') {
    return null;
  }
  return <PrinterCardAndroid />;
}

function PrinterCardAndroid() {
  const theme = useTheme();
  const printer = usePrinter();
  const [scanModalOpen, setScanModalOpen] = useState(false);
  const [showAllDevices, setShowAllDevices] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [bluetoothPromptOpen, setBluetoothPromptOpen] = useState(false);
  const [enablingBluetooth, setEnablingBluetooth] = useState(false);
  const [bluetoothPromptError, setBluetoothPromptError] = useState<string | null>(null);
  // Set when the OS Bluetooth permission is refused. Shown on the card rather
  // than in the enable prompt, because that prompt never opens in this case.
  const [permissionError, setPermissionError] = useState<string | null>(null);
  // What to do once Bluetooth turns on — opening the scan modal, or connecting
  // to a tapped recent device. A ref, not state: it never drives a render on
  // its own, only bluetoothPromptOpen does.
  const pendingAction = useRef<(() => void) | null>(null);
  // Measured rather than guessed, so the cap tracks the header's real height
  // (status line, optional error, buttons) instead of a made-up number.
  const [headerHeight, setHeaderHeight] = useState(0);

  function handleHeaderLayout(event: LayoutChangeEvent) {
    setHeaderHeight(event.nativeEvent.layout.height);
  }

  // Bluetooth can be toggled outside the app at any time, so this re-checks
  // on every tap rather than caching the result from the last check.
  async function runIfBluetoothOn(action: () => void) {
    // BLUETOOTH_CONNECT comes first, before anything touches the radio.
    // On Android 12+ the OS refuses to show its own "turn on Bluetooth?"
    // dialog to an app that doesn't hold it — the request is cancelled
    // without the dialog ever being drawn, which is indistinguishable from
    // the button not working. It's also what connecting to a printer needs,
    // so both paths through here want it granted.
    const granted = await ensureConnectPermission().catch((error: unknown) => {
      logError('printer.ensureConnectPermission', error);
      return false;
    });
    if (!granted) {
      setPermissionError(
        'NewOldWorld needs the Bluetooth permission to reach your receipt printer. Allow "Nearby devices" for NewOldWorld in your phone’s settings, then try again.',
      );
      return;
    }
    setPermissionError(null);

    // A failed check is treated as "off": the enable prompt is the useful
    // thing to show either way, and letting this reject would leave the tap
    // doing nothing at all with no explanation.
    const enabled = await isBluetoothEnabled().catch((error: unknown) => {
      logError('printer.isBluetoothEnabled', error);
      return false;
    });
    if (enabled) {
      action();
      return;
    }
    pendingAction.current = action;
    setBluetoothPromptError(null);
    setBluetoothPromptOpen(true);
  }

  async function handleEnableBluetooth() {
    setEnablingBluetooth(true);
    setBluetoothPromptError(null);
    try {
      await requestBluetoothEnabled();
      // The OS answers as soon as the user taps Allow, while the radio is
      // still coming up. Scanning or connecting in that window fails exactly
      // as if Bluetooth were still off, so wait for the adapter itself.
      if (!(await waitForBluetoothEnabled())) {
        setBluetoothPromptError('Bluetooth is taking a while to turn on. Try again in a moment.');
        return;
      }
      setBluetoothPromptOpen(false);
      const action = pendingAction.current;
      pendingAction.current = null;
      action?.();
    } catch (error: unknown) {
      // Logged, not just shown: the reasons are very different from each
      // other (the user declined, no permission, no activity) and the
      // message on screen can't tell them apart.
      logError('printer.requestBluetoothEnabled', error);
      setBluetoothPromptError('Bluetooth needs to be turned on to continue.');
    } finally {
      setEnablingBluetooth(false);
    }
  }

  function closeBluetoothPrompt() {
    setBluetoothPromptOpen(false);
    pendingAction.current = null;
    setBluetoothPromptError(null);
    // The native enable promise can be left unsettled if the activity is
    // recreated while the OS dialog is up, which would otherwise leave this
    // stuck true and the button disabled for the life of the screen.
    setEnablingBluetooth(false);
  }

  const statusLabel =
    printer.status === 'connected'
      ? `Connected to ${printer.connectedDevice?.name}`
      : printer.status === 'connecting'
        ? 'Connecting…'
        : 'No printer connected';

  function openScanModal() {
    runIfBluetoothOn(() => {
      setShowAllDevices(false);
      setScanModalOpen(true);
      printer.scan();
    });
  }

  // Stopping discovery is housekeeping — if it fails there's nothing useful to
  // say, and the modal should still close.
  async function stopScan() {
    await printer.cancelScan().catch((error: unknown) => logError('printer.cancelScan', error));
  }

  async function closeScanModal() {
    setScanModalOpen(false);
    await stopScan();
  }

  async function handleSelectDevice(device: PrinterDevice) {
    setScanModalOpen(false);
    await stopScan();
    // connect() reports its own failures through printer.lastError.
    await printer.connect(device);
  }

  async function handleDisconnect() {
    await runWithRetry(() => printer.disconnect(), {
      scope: 'printer.disconnect',
      title: 'Could not disconnect',
      message: 'The printer is still connected.',
    });
  }

  async function handlePrintTest() {
    setPrinting(true);
    // Printing is the most retry-worthy action in the app: the usual cause is
    // the printer being asleep, out of paper, or briefly out of range — all of
    // which the user can fix on the spot and try again.
    await runWithRetry(() => printer.printTest(), {
      scope: 'printer.printTest',
      title: 'Could not print',
      message: 'Check that the printer is on, has paper, and is in range.',
    });
    setPrinting(false);
  }

  // Favorites first (in the order they were starred), then the rest of the
  // recent list, most recent first.
  const savedDevices = [
    ...printer.favoriteDevices,
    ...printer.recentDevices.filter((d) => !printer.isFavorite(d.address)),
  ];
  const otherRecent = savedDevices.filter((d) => d.address !== printer.connectedDevice?.address);
  const recentListData = printer.status === 'connected' || printer.status === 'connecting' ? [] : otherRecent;
  // Favorites float to the top, otherwise discovery order is kept — a
  // one-pass split rather than a sort, since this reruns as each device turns
  // up. A favorite always shows even with the filter on: the driver already
  // said it's their printer, whatever name it broadcasts.
  const favoriteResults: PrinterDevice[] = [];
  const otherResults: PrinterDevice[] = [];
  for (const device of printer.scanResults) {
    if (printer.isFavorite(device.address)) {
      favoriteResults.push(device);
    } else if (showAllDevices || device.isPrinter) {
      otherResults.push(device);
    }
  }
  const visibleResults = [...favoriteResults, ...otherResults];
  const connected = printer.status === 'connected';
  // Card fits its (measured) header plus three recent rows before scrolling;
  // 0 until the header's first layout pass, so nothing gets clipped early.
  // Every row brings its own cardContent gap above it — leaving those out
  // clipped the third row, so the list looked like it ended with nothing to
  // scroll to.
  const cardMaxHeight = headerHeight
    ? Spacing.three * 2 + headerHeight + (Spacing.two + RECENT_ROW_HEIGHT) * VISIBLE_RECENT_ROWS
    : undefined;

  const header = (
    <View style={styles.cardHeader} onLayout={handleHeaderLayout}>
      <View style={styles.statusRow}>
        <View style={[styles.statusDot, { backgroundColor: connected ? '#30a46c' : theme.textSecondary }]} />
        <ThemedText type="smallBold" style={styles.statusText}>
          {statusLabel}
        </ThemedText>
        {printer.status === 'connecting' && <ActivityIndicator size="small" color={theme.textSecondary} />}
        {connected && printer.connectedDevice && (
          <FavoriteButton
            device={printer.connectedDevice}
            favorite={printer.isFavorite(printer.connectedDevice.address)}
            onToggle={printer.toggleFavorite}
          />
        )}
      </View>

      {(permissionError ?? printer.lastError) && (
        <ThemedText type="small" style={styles.error}>
          {permissionError ?? printer.lastError}
        </ThemedText>
      )}

      <View style={styles.actions}>
        {connected ? (
          <>
            <Pressable
              onPress={handlePrintTest}
              disabled={printing}
              style={({ pressed }) => [
                styles.button,
                { borderColor: theme.textSecondary, opacity: pressed || printing ? 0.6 : 1 },
              ]}>
              <ThemedText type="smallBold">{printing ? 'Printing…' : 'Print test'}</ThemedText>
            </Pressable>
            <Pressable
              onPress={handleDisconnect}
              style={({ pressed }) => [
                styles.button,
                { borderColor: theme.textSecondary, opacity: pressed ? 0.6 : 1 },
              ]}>
              <ThemedText type="smallBold">Disconnect</ThemedText>
            </Pressable>
          </>
        ) : (
          printer.status !== 'connecting' && (
            <Pressable
              onPress={openScanModal}
              style={({ pressed }) => [
                styles.button,
                { borderColor: theme.textSecondary, opacity: pressed ? 0.6 : 1 },
              ]}>
              <ThemedText type="smallBold">Scan for printers</ThemedText>
            </Pressable>
          )
        )}
      </View>

      {recentListData.length > 0 && (
        <ThemedText type="small" themeColor="textSecondary">
          Recent
        </ThemedText>
      )}
    </View>
  );

  const cardStyle = [
    styles.card,
    { backgroundColor: theme.backgroundElement, borderColor: connected ? '#30a46c' : theme.border },
  ];

  return (
    <>
      {/* No recent devices to show below the header: a plain View sized to its
          content, instead of a scroll view that (on Android) can keep its old
          scrollable height for a beat after dropping down to zero rows. */}
      {recentListData.length === 0 ? (
        <View style={[cardStyle, styles.cardContent]}>{header}</View>
      ) : (
        // A ScrollView, not a FlatList: Home already scrolls (<Screen scroll>),
        // and a FlatList inside a ScrollView triggers React Native's "VirtualizedLists
        // should never be nested" error. The list is at most a handful of rows, so
        // FlatList's windowing bought nothing. nestedScrollEnabled lets Android
        // scroll this card on its own inside the page.
        <ScrollView
          style={[cardStyle, { maxHeight: cardMaxHeight }]}
          contentContainerStyle={styles.cardContent}
          nestedScrollEnabled>
          {header}
          {recentListData.map((item) => (
            <DeviceRow
              key={item.address}
              device={item}
              onPress={() => runIfBluetoothOn(() => printer.connect(item))}
              favorite={printer.isFavorite(item.address)}
              onToggleFavorite={printer.toggleFavorite}
            />
          ))}
        </ScrollView>
      )}

      <Modal visible={scanModalOpen} transparent animationType="fade" onRequestClose={closeScanModal}>
        {/* Dimmed backdrop over the Home screen, with a fixed-size card
            centered on top, rather than a full-screen page — keeps the
            printer card it was opened from visible underneath. */}
        {/* No tap-to-close: pairing is a scan-and-wait, so the driver is
            looking at a list that fills in over several seconds with nothing to
            press yet — the moment a stray tap on the dim edge is most likely
            and most annoying. The ✕ closes it. */}
        <View style={styles.backdrop}>
          <View style={styles.sheetWrapper}>
            <View style={[styles.sheet, { backgroundColor: theme.background }]}>
              <View style={styles.modalHeader}>
                <ThemedText type="subtitle" style={styles.modalTitle}>
                  Select a printer
                </ThemedText>
                <Pressable
                  onPress={closeScanModal}
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

              <View style={styles.toggleRow}>
                <ThemedText type="default">Show all devices</ThemedText>
                <Switch
                  value={showAllDevices}
                  onValueChange={setShowAllDevices}
                  trackColor={{ false: theme.border, true: theme.text }}
                />
              </View>

              {printer.scanning && (
                <View style={styles.scanningRow}>
                  <ActivityIndicator size="small" color={theme.textSecondary} />
                  <ThemedText type="small" themeColor="textSecondary">
                    Scanning…
                  </ThemedText>
                </View>
              )}

              <FlatList
                data={visibleResults}
                keyExtractor={(device) => device.address}
                style={styles.modalList}
                contentContainerStyle={styles.modalListContent}
                renderItem={({ item }) => (
                  <DeviceRow
                    device={item}
                    onPress={() => handleSelectDevice(item)}
                    favorite={printer.isFavorite(item.address)}
                  />
                )}
                ListEmptyComponent={
                  !printer.scanning ? (
                    <ThemedText type="small" themeColor="textSecondary">
                      {showAllDevices
                        ? "No devices found. Make sure the printer is powered on and pair it in your phone's Bluetooth settings first if this is the first time."
                        : 'No thermal printers found. Try "Show all devices" — some printers don’t identify themselves correctly.'}
                    </ThemedText>
                  ) : null
                }
              />
            </View>
          </View>
        </View>
      </Modal>

      <Modal
        visible={bluetoothPromptOpen}
        transparent
        animationType="fade"
        onRequestClose={closeBluetoothPrompt}>
        <Pressable style={styles.backdrop} onPress={closeBluetoothPrompt}>
          <Pressable onPress={() => {}} style={styles.promptWrapper}>
            <View style={[styles.promptCard, { backgroundColor: theme.background }]}>
              <ThemedText type="subtitle">Turn on Bluetooth</ThemedText>
              <ThemedText type="default" themeColor="textSecondary">
                Bluetooth is off. Turn it on to find or connect to your receipt printer.
              </ThemedText>

              {bluetoothPromptError && (
                <ThemedText type="small" style={styles.error}>
                  {bluetoothPromptError}
                </ThemedText>
              )}

              <View style={styles.promptActions}>
                <Pressable
                  onPress={closeBluetoothPrompt}
                  style={({ pressed }) => [
                    styles.button,
                    { borderColor: theme.textSecondary, opacity: pressed ? 0.6 : 1 },
                  ]}>
                  <ThemedText type="smallBold">Cancel</ThemedText>
                </Pressable>
                <Pressable
                  onPress={handleEnableBluetooth}
                  disabled={enablingBluetooth}
                  style={({ pressed }) => [
                    styles.button,
                    { backgroundColor: theme.text, opacity: pressed || enablingBluetooth ? 0.6 : 1 },
                  ]}>
                  {enablingBluetooth ? (
                    <ActivityIndicator size="small" color={theme.background} />
                  ) : (
                    <ThemedText type="smallBold" style={{ color: theme.background }}>
                      Turn on Bluetooth
                    </ThemedText>
                  )}
                </Pressable>
              </View>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

type DeviceRowProps = {
  device: PrinterDevice;
  onPress: () => void;
  /**
   * With onToggleFavorite: a tappable star (Home's saved list). Without it: a
   * plain gold star on favorites only, nothing on the rest (the scan sheet).
   */
  favorite?: boolean;
  onToggleFavorite?: (device: PrinterDevice) => void;
};

function DeviceRow({ device, onPress, favorite, onToggleFavorite }: DeviceRowProps) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.deviceRow,
        { backgroundColor: pressed ? theme.backgroundSelected : 'transparent' },
      ]}>
      <ThemedText type="default" style={styles.deviceName} numberOfLines={1}>
        {device.name}
      </ThemedText>
      {favorite !== undefined && onToggleFavorite ? (
        <FavoriteButton device={device} favorite={favorite} onToggle={onToggleFavorite} />
      ) : (
        favorite && (
          <SymbolView
            name={{ ios: 'star.fill', android: 'star', web: 'star' }}
            tintColor={FAVORITE_COLOR}
            size={22}
            accessibilityLabel="Favorite"
          />
        )
      )}
    </Pressable>
  );
}

// Sized to fit inside a device row's 24px line height, so RECENT_ROW_HEIGHT
// stays true. Its own Pressable, so tapping the star doesn't also connect.
function FavoriteButton({
  device,
  favorite,
  onToggle,
}: {
  device: PrinterDevice;
  favorite: boolean;
  onToggle: (device: PrinterDevice) => void;
}) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={() => onToggle(device)}
      accessibilityRole="button"
      accessibilityLabel={favorite ? `Remove ${device.name} from favorites` : `Add ${device.name} to favorites`}
      accessibilityState={{ selected: favorite }}
      hitSlop={Spacing.two}
      style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}>
      {/* Colour as well as shape: Android's icon font can draw both stars as
          outlines, and gold vs grey still tells them apart. */}
      <SymbolView
        name={
          favorite
            ? { ios: 'star.fill', android: 'star', web: 'star' }
            : { ios: 'star', android: 'star_border', web: 'star_border' }
        }
        tintColor={favorite ? FAVORITE_COLOR : theme.textSecondary}
        size={22}
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  // Width comes from the parent (same as the rest of the Home screen).
  // Height shrinks to fit its content up to cardMaxHeight (computed above
  // from the real header height), then scrolls instead of growing further.
  card: {
    borderWidth: 2,
    borderRadius: Spacing.two,
    marginTop: Spacing.three,
    overflow: 'hidden',
  },
  cardContent: {
    padding: Spacing.three,
    gap: Spacing.two,
  },
  cardHeader: {
    gap: Spacing.two,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  // flex: 1 so the connected printer's star is pushed to the far right.
  statusText: {
    flex: 1,
  },
  error: {
    color: '#e5484d',
  },
  actions: {
    flexDirection: 'row',
    gap: Spacing.two,
  },
  button: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: Spacing.two,
    paddingVertical: Spacing.two,
    paddingHorizontal: Spacing.three,
  },
  deviceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    paddingVertical: Spacing.two,
    paddingHorizontal: Spacing.two,
    borderRadius: Spacing.one,
  },
  deviceName: {
    flex: 1,
  },
  backdrop: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.4)',
    padding: Spacing.four,
  },
  sheetWrapper: {
    width: '100%',
    maxWidth: MaxContentWidth,
    height: '50%',
  },
  sheet: {
    flex: 1,
    borderRadius: Spacing.four,
    paddingHorizontal: Spacing.four,
    overflow: 'hidden',
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: Spacing.three,
  },
  modalTitle: {
    flexShrink: 1,
  },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: Spacing.three,
  },
  scanningRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    paddingBottom: Spacing.two,
  },
  modalList: {
    flex: 1,
  },
  modalListContent: {
    paddingBottom: Spacing.four,
    gap: Spacing.half,
  },
  promptWrapper: {
    width: '100%',
    maxWidth: MaxContentWidth,
  },
  promptCard: {
    borderRadius: Spacing.four,
    padding: Spacing.four,
    gap: Spacing.two,
  },
  promptActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: Spacing.two,
    marginTop: Spacing.two,
  },
});
