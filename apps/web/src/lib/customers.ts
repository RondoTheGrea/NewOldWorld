import { collection, getDocs, onSnapshot } from 'firebase/firestore';

import { db } from '@/lib/firebase';

/**
 * Stores, as the dashboard sees them.
 *
 * Unlike bread types, areas and trucks, **customers are not dashboard-owned**.
 * Every phone creates and edits them and every phone pulls them back down —
 * a store belongs to the business, not to the truck that happened to meet it.
 * The dashboard is a reader here: this file has no writes, and adding one would
 * mean thinking hard about the last-write-wins merge the phones already run
 * (see docs/route-tracking-design.md).
 *
 * **Deletes are soft, and that has to be honoured on the way in.** A phone
 * deleting a store sets `deleted: true` and bumps `updatedAt` rather than
 * removing the document, because a hard delete is invisible to the
 * "everything changed since I last looked" query the phones sync with — an
 * offline device would keep the store on its route forever. So the rows are
 * still here, and anything that lists stores has to filter them out.
 */

export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export type Customer = {
  id: string;
  storeName: string;
  /** The contact person at the store, not the store itself. */
  name: string;
  deliveryDays: Weekday[];
  areaId: string | null;
  /** References an `agentGroups` doc — the crew this store is assigned to, or null. Optional on the phone. */
  agentGroupId: string | null;
  address: string;
  phone: string;
  description: string;
  createdAt: number;
  updatedAt: number;
};

/**
 * Live-subscribes to every store that hasn't been deleted, sorted by name.
 *
 * Read whole and sorted here rather than with `orderBy`, for the same reason
 * the runs query is: a distributor has hundreds of stores, not millions, and an
 * `orderBy('storeName')` would silently drop any document that somehow lacks
 * the field — which is exactly the document someone would then go looking for.
 */
export function watchCustomers(
  callback: (customers: Customer[]) => void,
  onError: (error: Error) => void,
) {
  return onSnapshot(
    collection(db, 'customers'),
    (snapshot) => callback(readCustomers(snapshot.docs)),
    onError,
  );
}

/**
 * Every live store, read once.
 *
 * The period export's counterpart to the listener above, and the reason it
 * exists: that workbook's Stores sheet is a list of who owes money, so it wants
 * the phone number and the round beside each figure — and neither is on a
 * receipt. Soft deletes are honoured here exactly as they are above; a store
 * that was removed can still appear on the sheet through the receipts it left
 * behind, just without the catalog's details.
 */
export async function fetchCustomers(): Promise<Customer[]> {
  const snapshot = await getDocs(collection(db, 'customers'));
  return readCustomers(snapshot.docs);
}

/** One reader for both, so a live store and an exported one can't differ. */
function readCustomers(docs: { id: string; data: () => Record<string, unknown> }[]): Customer[] {
  return docs
    .filter((snap) => snap.data().deleted !== true)
    .map((snap): Customer => {
      const data = snap.data();
      return {
        id: snap.id,
        storeName: (data.storeName as string) ?? '',
        name: (data.name as string) ?? '',
        deliveryDays: Array.isArray(data.deliveryDays)
          ? (data.deliveryDays as Weekday[]).filter((day) => WEEKDAYS.includes(day))
          : [],
        areaId: (data.areaId as string | null) || null,
        agentGroupId: (data.agentGroupId as string | null) || null,
        address: (data.address as string) ?? '',
        phone: (data.phone as string) ?? '',
        description: (data.description as string) ?? '',
        createdAt: (data.createdAt as number) ?? 0,
        updatedAt: (data.updatedAt as number) ?? 0,
      };
    })
    .sort((a, b) => a.storeName.localeCompare(b.storeName));
}

/** "Mon, Wed, Fri" — always in week order, however they were tapped on the phone. */
export function formatDeliveryDays(days: Weekday[]): string {
  const ordered = WEEKDAYS.filter((day) => days.includes(day));
  if (ordered.length === 0) return 'No set days';
  if (ordered.length === 7) return 'Every day';
  return ordered.join(', ');
}
