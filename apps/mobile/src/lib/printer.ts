/**
 * Thin wrapper around react-native-bluetooth-classic, scoped to what the
 * receipt printer needs. Isolates the third-party API so the rest of the app
 * only deals with plain {address, name} devices and never imports the
 * library directly. Android only — see src/components/printer-card.tsx for
 * why this feature doesn't exist on iOS.
 */

import { Buffer } from 'buffer';
import RNBluetoothClassic, { type BluetoothDeviceEvent } from 'react-native-bluetooth-classic';
import { PermissionsAndroid, Platform } from 'react-native';

export type PrinterDevice = {
  address: string;
  name: string;
  /** Best-effort guess at whether this is a printer, for the scan list's default filter. */
  isPrinter: boolean;
};

// Android's Bluetooth "Class of Device" values for printers (android.bluetooth.BluetoothClass).
// Most generic ESC/POS printers report these correctly; the ones that don't tend to still
// announce themselves with a name that mentions printing, so that's the fallback signal.
const PRINTER_MAJOR_DEVICE_CLASS = 0x0600; // BluetoothClass.Device.Major.IMAGING
const PRINTER_DEVICE_CLASS = 0x0680; // BluetoothClass.Device.IMAGING_PRINTER
const PRINTER_NAME_HINTS = ['print', 'pos', 'thermal', 'receipt', 'escpos', 'esc-pos'];

function looksLikePrinter(name: string, deviceClass: unknown): boolean {
  const raw = deviceClass as { deviceClass?: number; majorClass?: number } | undefined;
  if (raw?.majorClass === PRINTER_MAJOR_DEVICE_CLASS || raw?.deviceClass === PRINTER_DEVICE_CLASS) {
    return true;
  }
  const lowerName = name.toLowerCase();
  return PRINTER_NAME_HINTS.some((hint) => lowerName.includes(hint));
}

function toPrinterDevice(device: { address: string; name?: string; deviceClass?: unknown }): PrinterDevice {
  const name = device.name || device.address;
  return { address: device.address, name, isPrinter: looksLikePrinter(name, device.deviceClass) };
}

/**
 * Requests the runtime Bluetooth permissions needed to scan/connect.
 * Android 12+ (API 31+) uses BLUETOOTH_SCAN/BLUETOOTH_CONNECT; older Android
 * needs ACCESS_FINE_LOCATION for discovery to return results at all.
 * Resolves false if the user denies any of them.
 */
export async function ensurePermissions(): Promise<boolean> {
  if (Platform.OS !== 'android') {
    return false;
  }

  const permissions =
    Platform.Version >= 31
      ? [PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN, PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT]
      : [PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION];

  const results = await PermissionsAndroid.requestMultiple(permissions);
  return Object.values(results).every((result) => result === PermissionsAndroid.RESULTS.GRANTED);
}

/**
 * Requests just BLUETOOTH_CONNECT, which on Android 12+ (API 31+) is what the
 * OS checks before it will show the "turn on Bluetooth?" dialog *or* let the
 * app open a socket to a printer. Without it the system cancels the enable
 * request without ever drawing the dialog, so the button looks broken.
 * Below API 31 it's an install-time permission with nothing to ask for, and
 * ACCESS_FINE_LOCATION is deliberately not requested here — that one is only
 * needed to *discover* devices (see ensurePermissions), not to connect to a
 * printer this phone already knows.
 */
export async function ensureConnectPermission(): Promise<boolean> {
  if (Platform.OS !== 'android') {
    return false;
  }
  if (Platform.Version < 31) {
    return true;
  }
  const result = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT);
  return result === PermissionsAndroid.RESULTS.GRANTED;
}

export async function isBluetoothEnabled(): Promise<boolean> {
  return RNBluetoothClassic.isBluetoothEnabled();
}

/** Prompts the OS "turn on Bluetooth?" dialog. */
export async function requestBluetoothEnabled(): Promise<boolean> {
  return RNBluetoothClassic.requestBluetoothEnabled();
}

// The OS reports "yes" the moment the user taps Allow, while the adapter is
// still TURNING_ON. Anything that touches the radio in that window fails as
// though Bluetooth were off, so the wait below is what stands between a
// successful enable and "Could not scan for printers".
const AdapterReadyTimeoutMs = 6000;
const AdapterPollMs = 250;

/**
 * Waits for the adapter to actually report enabled after the user turns it on.
 * Resolves false if it never does within the timeout, rather than hanging.
 */
export async function waitForBluetoothEnabled(): Promise<boolean> {
  const deadline = Date.now() + AdapterReadyTimeoutMs;
  for (;;) {
    if (await isBluetoothEnabled()) {
      return true;
    }
    if (Date.now() >= deadline) {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, AdapterPollMs));
  }
}

/** Scans for nearby devices via a live Bluetooth inquiry. Android only, ~12s. */
export async function startDiscovery(): Promise<PrinterDevice[]> {
  const devices = await RNBluetoothClassic.startDiscovery();
  return devices.map(toPrinterDevice);
}

export async function cancelDiscovery(): Promise<void> {
  await RNBluetoothClassic.cancelDiscovery();
}

/** Fires as each device turns up during discovery, ahead of startDiscovery()'s final list. */
export function onDeviceDiscovered(listener: (device: PrinterDevice) => void) {
  return RNBluetoothClassic.onDeviceDiscovered((event: BluetoothDeviceEvent) => {
    listener(toPrinterDevice(event.device));
  });
}

/** Opens a connection to a device by address. Throws if the connection fails. */
export async function connect(address: string): Promise<PrinterDevice> {
  const device = await RNBluetoothClassic.connectToDevice(address);
  return toPrinterDevice(device);
}

export async function disconnect(address: string): Promise<void> {
  await RNBluetoothClassic.disconnectFromDevice(address);
}

export async function isConnected(address: string): Promise<boolean> {
  return RNBluetoothClassic.isDeviceConnected(address);
}

/** Looks up a device that's already connected, without opening a new socket. */
export async function getConnectedDevice(address: string): Promise<PrinterDevice> {
  const device = await RNBluetoothClassic.getConnectedDevice(address);
  return toPrinterDevice(device);
}

// These printers have a small receive buffer and no flow control on the
// Bluetooth serial link, so a whole receipt pushed as one write can overrun it
// and come out truncated or garbled. Sending it in small chunks with a breath
// in between is the standard workaround; a short test print is a single chunk,
// so it costs nothing there.
const WRITE_CHUNK_SIZE = 256;
const WRITE_CHUNK_PAUSE_MS = 20;

/** Sends raw ESC/POS command bytes, e.g. from src/lib/escpos.ts. */
export async function writeBytes(address: string, bytes: number[]): Promise<void> {
  for (let offset = 0; offset < bytes.length; offset += WRITE_CHUNK_SIZE) {
    if (offset > 0) {
      await new Promise((resolve) => setTimeout(resolve, WRITE_CHUNK_PAUSE_MS));
    }
    const chunk = bytes.slice(offset, offset + WRITE_CHUNK_SIZE);
    await RNBluetoothClassic.writeToDevice(address, Buffer.from(chunk));
  }
}

/** Fires when a connected device drops (out of range, powered off, etc). */
export function onDisconnected(listener: (address: string) => void) {
  return RNBluetoothClassic.onDeviceDisconnected((event: BluetoothDeviceEvent) => {
    listener(event.device.address);
  });
}
