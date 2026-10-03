import AsyncStorage from '@react-native-async-storage/async-storage';
import { createContext, use, useEffect, useRef, useState, type PropsWithChildren } from 'react';
import { Platform } from 'react-native';

import * as escpos from '@/lib/escpos';
import { logError } from '@/lib/errors';
import * as printer from '@/lib/printer';
import { type PrinterDevice } from '@/lib/printer';
import { receiptPrintBytes, type ReceiptPrintLine } from '@/lib/receipt-print';

const RECENT_KEY = 'printer.recent';
const FAVORITES_KEY = 'printer.favorites';
const AUTO_CONNECT_KEY = 'printer.autoConnect';

type PrinterStatus = 'disconnected' | 'connecting' | 'connected';

type PrinterContextValue = {
  status: PrinterStatus;
  connectedDevice: PrinterDevice | null;
  recentDevices: PrinterDevice[];
  /** Starred printers, in the order they were starred. */
  favoriteDevices: PrinterDevice[];
  /** Constant-time: backed by a Set, so checking every row of a long list stays cheap. */
  isFavorite: (address: string) => boolean;
  toggleFavorite: (device: PrinterDevice) => void;
  /** Paired + discovered devices from the most recent scan(). */
  scanResults: PrinterDevice[];
  scanning: boolean;
  /** Set after a connect() failure so the UI can show why. Cleared on the next attempt. */
  lastError: string | null;
  scan: () => Promise<void>;
  cancelScan: () => Promise<void>;
  connect: (device: PrinterDevice) => Promise<void>;
  disconnect: () => Promise<void>;
  printTest: () => Promise<void>;
  /** Prints a receipt built by lib/receipt-print.ts. Throws if no printer is connected. */
  printReceipt: (lines: ReceiptPrintLine[]) => Promise<void>;
};

const PrinterContext = createContext<PrinterContextValue | null>(null);

export function usePrinter() {
  const value = use(PrinterContext);
  if (!value) {
    throw new Error('usePrinter must be used inside a <PrinterProvider>');
  }
  return value;
}

async function loadDevices(key: string): Promise<PrinterDevice[]> {
  const raw = await AsyncStorage.getItem(key);
  return raw ? (JSON.parse(raw) as PrinterDevice[]) : [];
}

function withMostRecentFirst(recent: PrinterDevice[], device: PrinterDevice): PrinterDevice[] {
  // No cap: every printer this phone has connected to stays listed.
  const rest = recent.filter((d) => d.address !== device.address);
  return [device, ...rest];
}

export function PrinterProvider({ children }: PropsWithChildren) {
  const [status, setStatus] = useState<PrinterStatus>('disconnected');
  const [connectedDevice, setConnectedDevice] = useState<PrinterDevice | null>(null);
  const [recentDevices, setRecentDevices] = useState<PrinterDevice[]>([]);
  const [favoriteDevices, setFavoriteDevices] = useState<PrinterDevice[]>([]);
  const [scanResults, setScanResults] = useState<PrinterDevice[]>([]);
  const [scanning, setScanning] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const connectedAddress = useRef<string | null>(null);
  const scanCancelled = useRef(false);

  useEffect(() => {
    if (Platform.OS !== 'android') {
      return;
    }

    let cancelled = false;

    (async () => {
      // Reading the saved list can itself fail (storage unavailable). Nothing
      // downstream can run without it, so it's logged and the card simply
      // starts with no recent devices instead of leaving a rejected promise.
      const stored = await Promise.all([
        loadDevices(RECENT_KEY),
        loadDevices(FAVORITES_KEY),
        AsyncStorage.getItem(AUTO_CONNECT_KEY),
      ]).catch((error: unknown) => {
        logError('printer.loadRecent', error);
        return null;
      });
      if (cancelled || !stored) return;
      const [recent, favorites, autoConnectAddress] = stored;
      setRecentDevices(recent);
      setFavoriteDevices(favorites);

      if (!autoConnectAddress) return;
      setStatus('connecting');
      try {
        // A JS-only reload restarts this effect but not the native module, so
        // a previous connection's socket can still be open — reusing it
        // avoids a doomed second connectToDevice() that would otherwise knock
        // the UI back to "disconnected" while the printer is still connected.
        const alreadyConnected = await printer.isConnected(autoConnectAddress);
        const device = alreadyConnected
          ? await printer.getConnectedDevice(autoConnectAddress)
          : await printer.connect(autoConnectAddress);
        if (cancelled) return;
        connectedAddress.current = device.address;
        setConnectedDevice(device);
        setStatus('connected');
      } catch {
        // Printer not in range / powered off — stay disconnected, no error
        // noise on a silent background attempt.
        if (!cancelled) setStatus('disconnected');
      }
    })();

    const subscription = printer.onDisconnected((address) => {
      if (address === connectedAddress.current) {
        connectedAddress.current = null;
        setConnectedDevice(null);
        setStatus('disconnected');
      }
    });

    return () => {
      cancelled = true;
      subscription.remove();
    };
  }, []);

  const scan = async () => {
    if (Platform.OS !== 'android') return;
    setLastError(null);
    // A thrown permission check is treated as "not granted" — the same
    // message applies, and scan() is called without awaiting, so a rejection
    // here would surface as nothing happening at all.
    const granted = await printer.ensurePermissions().catch((error: unknown) => {
      logError('printer.ensurePermissions', error);
      return false;
    });
    if (!granted) {
      setLastError('Bluetooth permission is needed to find your receipt printer.');
      return;
    }

    scanCancelled.current = false;
    setScanning(true);
    setScanResults([]);

    // Live discovery only — getBondedDevices() would also surface every
    // device this phone has ever paired with (old earbuds, a previous phone,
    // a car), most of which aren't nearby or a printer at all.
    const subscription = printer.onDeviceDiscovered((device) => {
      setScanResults((current) => {
        const index = current.findIndex((d) => d.address === device.address);
        if (index === -1) return [...current, device];
        const next = [...current];
        next[index] = device;
        return next;
      });
    });

    try {
      // A single startDiscovery() round only runs ~12s on Android, so keep
      // restarting it back to back for as long as the scan modal is open —
      // the caller only sees this resolve once cancelScan() has run.
      while (!scanCancelled.current) {
        await printer.startDiscovery();
      }
    } catch {
      if (!scanCancelled.current) {
        setLastError('Could not scan for printers. Make sure Bluetooth is turned on.');
      }
    } finally {
      subscription.remove();
      setScanning(false);
    }
  };

  const cancelScan = async () => {
    if (Platform.OS !== 'android') return;
    scanCancelled.current = true;
    await printer.cancelDiscovery();
  };

  const connect = async (device: PrinterDevice) => {
    setLastError(null);
    setStatus('connecting');
    try {
      const connected = await printer.connect(device.address);
      connectedAddress.current = connected.address;
      setConnectedDevice(connected);
      setStatus('connected');

      const nextRecent = withMostRecentFirst(recentDevices, connected);
      setRecentDevices(nextRecent);
      // Remembering the printer for next launch is a convenience, and it must
      // not be able to turn a *successful* connection into "Could not connect"
      // by throwing into the catch below — hence its own handler.
      await Promise.all([
        AsyncStorage.setItem(RECENT_KEY, JSON.stringify(nextRecent)),
        AsyncStorage.setItem(AUTO_CONNECT_KEY, connected.address),
      ]).catch((error: unknown) => logError('printer.rememberDevice', error));
    } catch {
      setStatus('disconnected');
      setLastError(`Could not connect to ${device.name}.`);
    }
  };

  const disconnect = async () => {
    if (!connectedDevice) return;
    try {
      await printer.disconnect(connectedDevice.address);
    } finally {
      // The auto-connect target on disk is left untouched on purpose: a
      // manual disconnect should still reconnect to the same printer next
      // launch, until the user manually connects to a different one.
      connectedAddress.current = null;
      setConnectedDevice(null);
      setStatus('disconnected');
    }
  };

  // React Compiler keeps this Set until favoriteDevices changes, so it isn't
  // rebuilt on every render.
  const favoriteAddresses = new Set(favoriteDevices.map((d) => d.address));
  const isFavorite = (address: string) => favoriteAddresses.has(address);

  const toggleFavorite = (device: PrinterDevice) => {
    const next = isFavorite(device.address)
      ? favoriteDevices.filter((d) => d.address !== device.address)
      : [...favoriteDevices, device];
    setFavoriteDevices(next);
    // A convenience, like the recent list: if saving fails the star still
    // works for this session, so it's logged rather than shown.
    AsyncStorage.setItem(FAVORITES_KEY, JSON.stringify(next)).catch((error: unknown) =>
      logError('printer.saveFavorites', error),
    );
  };

  const printTest = async () => {
    if (!connectedDevice) return;
    const bytes = escpos.build(
      escpos.init(),
      escpos.alignCenter(),
      escpos.line('NewOldWorld POS'),
      escpos.alignLeft(),
      escpos.line('Test print OK'),
      escpos.feed(2),
      escpos.cut(),
    );
    await printer.writeBytes(connectedDevice.address, bytes);
  };

  const printReceipt = async (lines: ReceiptPrintLine[]) => {
    if (!connectedDevice) {
      throw new Error('No printer connected.');
    }
    await printer.writeBytes(connectedDevice.address, receiptPrintBytes(lines));
  };

  const value: PrinterContextValue = {
    status,
    connectedDevice,
    recentDevices,
    favoriteDevices,
    isFavorite,
    toggleFavorite,
    scanResults,
    scanning,
    lastError,
    scan,
    cancelScan,
    connect,
    disconnect,
    printTest,
    printReceipt,
  };

  return <PrinterContext value={value}>{children}</PrinterContext>;
}
