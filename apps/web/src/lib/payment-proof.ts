import { getBlob, getDownloadURL, ref } from 'firebase/storage';

import { storage } from '@/lib/firebase';

/**
 * Turning a stored `proofStoragePath` into something an `<img>` can load.
 *
 * The dashboard is **read-only against Storage** — it never uploads, never
 * deletes, and `storage.rules` would refuse it anyway (writes require
 * `createdByUid` to match the signed-in account, which no dashboard account can
 * satisfy). All this does is exchange a path for a signed URL.
 *
 * Why a fetch at all, when everything else on the receipt panel is already in
 * hand: an object path is not a URL. The bucket is private, so the browser can
 * only load the image through a token-bearing URL that `getDownloadURL`
 * requests on the caller's credentials. That is one round trip per photo, which
 * is why it happens when the photo is opened rather than for every row in a
 * run's feed.
 */

/**
 * What went wrong, in words someone reading the server's copy can act on.
 *
 * The two cases are genuinely different and must not be collapsed:
 * `storage/object-not-found` means the phone recorded a path for bytes that
 * aren't in the bucket — a real gap — while anything else is most likely this
 * browser's own connection or permissions.
 * Reporting both as "couldn't load the photo" would send someone chasing a
 * network problem over a missing file, or the reverse.
 */
export function describeProofError(error: unknown): string {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  if (code === 'storage/object-not-found') {
    return 'The phone recorded a photo for this receipt, but the file never reached the server.';
  }
  if (code === 'storage/unauthorized') {
    return 'This account is not allowed to open payment photos.';
  }
  return 'Could not load the photo. Check your connection and try again.';
}

/** Resolves a download URL for one proof photo. Rejects — callers show `describeProofError`. */
export function paymentProofUrl(storagePath: string): Promise<string> {
  return getDownloadURL(ref(storage, storagePath));
}

/**
 * The same photo, but as bytes this browser is holding — for the Excel export,
 * which has to put the image *inside* the workbook rather than link to it.
 *
 * A download URL is no use there: the file is meant to be opened next week, off
 * a shared drive, by someone who may not be signed in, and the token in a
 * download URL is not a promise of either. So the export downloads the bytes at
 * export time and embeds them.
 *
 * **This is the one read that needs CORS on the bucket.** `<img src={url}>`
 * never did — the browser will render a cross-origin image it is not allowed to
 * *read*. `getBlob` reads, so the bucket has to say the dashboard's origin is
 * welcome (`firebase/storage-cors.json`; the Storage emulator already allows
 * every origin, so local dev works untouched). Without it this rejects with
 * `storage/unknown` and the export writes a note in the cell instead of a
 * photo — the file is still produced.
 */
export type PaymentProofImage = {
  /**
   * A `data:` URI. ExcelJS's browser build takes images as base64 and strips
   * the prefix itself, so handing it the whole URI is correct.
   */
  base64: string;
  extension: 'jpeg' | 'png' | 'gif';
  /** Real pixel dimensions, so the export can scale to a box without distorting. */
  width: number;
  height: number;
};

/**
 * Long, because this is a photo rather than a document — the same reasoning as
 * mobile's `UploadTimeoutMs`. It exists at all because a stalled download would
 * otherwise leave the export button on "Exporting…" forever.
 */
const ProofDownloadTimeoutMs = 30_000;

function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Sniffed from the first bytes rather than trusted from the path or the blob's
 * `type`. The path is always `.jpg` because that is what mobile names it, and a
 * mislabelled image is one of the few things Excel refuses to open at all.
 */
function extensionOf(head: Uint8Array): PaymentProofImage['extension'] {
  if (head[0] === 0x89 && head[1] === 0x50) return 'png';
  if (head[0] === 0x47 && head[1] === 0x49) return 'gif';
  return 'jpeg';
}

/**
 * Width and height, needed only as a ratio — the export fits every photo into
 * the same box. A decode that fails falls back to 4:3 rather than failing the
 * photo: a slightly wrong shape is a far better outcome than a missing receipt.
 */
async function measure(blob: Blob): Promise<{ width: number; height: number }> {
  try {
    const bitmap = await createImageBitmap(blob);
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return size;
  } catch {
    return { width: 4, height: 3 };
  }
}

function toDataUri(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the photo.'));
    reader.readAsDataURL(blob);
  });
}

/** Downloads one proof photo as embeddable bytes. Rejects — callers report it per row. */
export async function fetchPaymentProofImage(storagePath: string): Promise<PaymentProofImage> {
  const blob = await withTimeout(
    getBlob(ref(storage, storagePath)),
    ProofDownloadTimeoutMs,
    'The photo took too long to download.',
  );
  const head = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
  const [size, base64] = await Promise.all([measure(blob), toDataUri(blob)]);
  return { base64, extension: extensionOf(head), ...size };
}
