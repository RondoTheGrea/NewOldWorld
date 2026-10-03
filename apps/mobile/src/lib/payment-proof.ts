import { Directory, File, Paths } from 'expo-file-system';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';

import { logError } from '@/lib/errors';

// Camera only — no gallery step — matching the "prompt the camera, snap one
// picture, hand it back" flow this is used for (GCash/Cheque proof photos).
// The picker's own result URI lives in a cache location that isn't
// guaranteed to survive an app restart, so it's copied into the app's
// persistent document directory before being handed to receipt-db.ts.

const PROOF_DIR_NAME = 'payment-proofs';

/**
 * Longest edge, in pixels, a stored proof photo is allowed to have.
 *
 * These photos are only ever looked at inside a modal on a phone screen, but a
 * modern phone camera writes 12+ megapixels, so an untouched capture lands at
 * roughly 1–3 MB. One per GCash/cheque receipt, kept forever, on a shared truck
 * phone that also has to hold the databases — this is the difference between
 * tens of megabytes a year and several gigabytes. At 1280px the photo is still
 * far more detail than the modal can show, and lands around 150 KB.
 *
 * `quality` on the picker alone does not do this: it changes JPEG compression,
 * not the pixel dimensions.
 */
const MaxProofEdgePixels = 1280;

function proofDirectory(): Directory {
  return new Directory(Paths.document, PROOF_DIR_NAME);
}

/**
 * Shrinks the capture to MaxProofEdgePixels on its longest edge. A photo
 * already smaller than that is left alone.
 *
 * If the resize itself fails, the original is used rather than losing the
 * photo the user just took — a large file is a much smaller problem than a
 * proof of payment that didn't save.
 */
async function shrink(uri: string, width: number, height: number): Promise<string> {
  const longestEdge = Math.max(width, height);
  if (longestEdge <= MaxProofEdgePixels || longestEdge === 0) return uri;

  try {
    const context = ImageManipulator.manipulate(uri);
    // Only the longer edge is constrained; the other is passed as null so the
    // aspect ratio is preserved rather than the photo being squashed.
    context.resize(width >= height ? { width: MaxProofEdgePixels } : { height: MaxProofEdgePixels });
    const rendered = await context.renderAsync();
    const result = await rendered.saveAsync({ format: SaveFormat.JPEG, compress: 0.7 });
    return result.uri;
  } catch (error) {
    logError('paymentProof.resize', error);
    return uri;
  }
}

/**
 * Opens the camera for a single photo and copies it into persistent storage.
 * Returns null if the user cancels or denies camera permission.
 */
export async function capturePaymentProof(receiptId: string): Promise<{ fileName: string; localUri: string } | null> {
  const permission = await ImagePicker.requestCameraPermissionsAsync();
  if (!permission.granted) return null;

  const result = await ImagePicker.launchCameraAsync({ allowsEditing: false, quality: 0.7 });
  if (result.canceled || !result.assets[0]) return null;

  const asset = result.assets[0];
  const sourceUri = await shrink(asset.uri, asset.width, asset.height);

  const proofDir = proofDirectory();
  proofDir.create({ idempotent: true });

  const fileName = `${receiptId}.jpg`;
  const sourceFile = new File(sourceUri);
  const destFile = new File(proofDir, fileName);
  // A retake after a cancelled setPaymentProof (e.g. a prior save that
  // failed) would otherwise collide with the file left behind by that
  // attempt — copy() errors if the destination already exists.
  if (destFile.exists) destFile.delete();
  await sourceFile.copy(destFile);

  return { fileName, localUri: destFile.uri };
}

/**
 * Deletes every stored proof photo.
 *
 * Called when receipts are cleared: the rows that point at these files are
 * going away, so without this the photos become unreachable from the app while
 * still occupying the phone's storage — invisible files that nothing can ever
 * delete again.
 *
 * Failures are logged, not thrown. This runs alongside a database wipe that
 * has already succeeded; leaving orphaned files behind is untidy, but failing
 * the whole "clear receipts" action over it would be worse, and re-running it
 * later will clean up whatever is left.
 */
export async function deleteAllPaymentProofs(): Promise<void> {
  try {
    const proofDir = proofDirectory();
    if (proofDir.exists) proofDir.delete();
  } catch (error) {
    logError('paymentProof.deleteAll', error);
  }
}
