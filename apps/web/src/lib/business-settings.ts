import { doc, onSnapshot, serverTimestamp, setDoc } from 'firebase/firestore';

import { db } from '@/lib/firebase';

/**
 * Business-wide details printed on every receipt — name, contact number, and
 * the closing line. A single doc (not a collection) since there's only ever
 * one business using this POS. Mobile reads this and falls back to its own
 * last-cached copy when offline; see apps/mobile/src/context/business-settings.tsx.
 */
export type BusinessSettings = {
  name: string;
  contactNumber: string;
  receiptEndingMessage: string;
};

const businessSettingsDoc = doc(db, 'settings', 'business');

/** Live-subscribes to the settings doc. Returns the unsubscribe fn. */
export function watchBusinessSettings(callback: (settings: BusinessSettings | null) => void) {
  return onSnapshot(businessSettingsDoc, (snapshot) => {
    if (!snapshot.exists()) {
      callback(null);
      return;
    }
    const data = snapshot.data();
    callback({
      name: (data.name as string) ?? '',
      contactNumber: (data.contactNumber as string) ?? '',
      receiptEndingMessage: (data.receiptEndingMessage as string) ?? '',
    });
  });
}

/**
 * The ending message is the one field where a line break is meaningful — the
 * receipt prints each typed line centred on its own line — so it is the one
 * field that keeps newlines instead of collapsing to a single line.
 *
 * What is cleaned up is everything a break *isn't*: CRLF becomes a plain
 * newline, other whitespace (tabs, stray carriage returns) collapses to a
 * space, trailing spaces on a line go, three or more blank lines collapse to
 * one gap, and the whole thing is capped — the receipt is 32 characters wide,
 * so a pasted wall of text is metres of paper. Anything else invisible is
 * neutralised on the phone, where it matters: on an ESC/POS link a control
 * character inside text is a printer command (apps/mobile/src/lib/escpos.ts).
 */
const EndingMessageMaxLength = 240;

function sanitizeEndingMessage(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, EndingMessageMaxLength)
    .trim();
}

/**
 * Exactly what `updateBusinessSettings` will store for a given draft.
 *
 * Exported so the Settings page's review screen can show the *saved* value
 * rather than the typed one — otherwise a trailing space or a third blank line
 * would be listed as a change, be quietly cleaned on the way to Firestore, and
 * the page would then disagree with the review the owner just confirmed.
 */
export function cleanBusinessSettings(input: BusinessSettings): BusinessSettings {
  return {
    name: input.name.trim(),
    contactNumber: input.contactNumber.trim(),
    receiptEndingMessage: sanitizeEndingMessage(input.receiptEndingMessage),
  };
}

export async function updateBusinessSettings(input: BusinessSettings) {
  const cleaned = cleanBusinessSettings(input);
  await setDoc(businessSettingsDoc, { ...cleaned, updatedAt: serverTimestamp() }, { merge: true });
}
