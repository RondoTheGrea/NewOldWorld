import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
} from 'firebase/firestore';

import { db } from '@/lib/firebase';

/**
 * Trucks and agents — the reference lists the mobile setup screen reads to
 * identify what a truck is doing today.
 *
 * Both are just `{ name, order }`, so one module covers them. They matter more
 * than their shape suggests: the **id** of the doc a manager creates here is
 * what every uploaded run, receipt and ledger entry is grouped by. Trucks used
 * to be typed into each phone, which minted an id only that phone knew about
 * and made "show me Truck 3's day" impossible to answer.
 *
 * Renaming is therefore safe and deleting is mostly safe: the id never changes
 * on a rename, and runs snapshot the *name* at the time they started, so
 * history never rewrites itself. See docs/sync-design.md.
 *
 * Agents used to live in their own module because they were grouped into
 * crews; crews were removed, so they are a flat list like trucks. An agent doc
 * written back then may still carry a `groupId` — nothing reads it.
 */

export type NamedRecord = {
  id: string;
  name: string;
  /** Manual display position on the dashboard — lower shows first. Not necessarily contiguous. */
  order: number;
};

export type NamedRecordInput = { name: string; order: number };

/** The collections this module manages. Adding a third means adding it here and a section on the page. */
export type NamedCollection = 'trucks' | 'agents';

/**
 * Live-subscribes to one list, sorted by the manual `order` field — the same
 * pattern watchBreadTypes uses. The underlying query still asks Firestore for
 * name order — `orderBy('order')` would silently drop any doc that doesn't
 * have the field yet, which is exactly the docs that predate this feature.
 * Instead every doc is read, missing `order` is backfilled here to its
 * current alphabetical position (a one-time, self-healing write), and the
 * real sort happens client-side. Returns the unsubscribe fn.
 */
export function watchNamedRecords(collectionName: NamedCollection, callback: (records: NamedRecord[]) => void) {
  const q = query(collection(db, collectionName), orderBy('name'));
  return onSnapshot(q, (snapshot) => {
    const records = snapshot.docs.map((d, index) => {
      const data = d.data();
      const hasOrder = typeof data.order === 'number';
      const order = hasOrder ? (data.order as number) : index;
      if (!hasOrder) {
        void updateDoc(doc(db, collectionName, d.id), { order });
      }
      return { id: d.id, name: (data.name as string) ?? '', order };
    });
    callback([...records].sort((a, b) => a.order - b.order));
  });
}

export async function addNamedRecord(collectionName: NamedCollection, input: NamedRecordInput) {
  await addDoc(collection(db, collectionName), {
    ...input,
    name: input.name.trim(),
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
}

export async function updateNamedRecord(collectionName: NamedCollection, id: string, input: NamedRecordInput) {
  await updateDoc(doc(db, collectionName, id), {
    ...input,
    name: input.name.trim(),
    updatedAt: serverTimestamp(),
  });
}

export async function deleteNamedRecord(collectionName: NamedCollection, id: string) {
  await deleteDoc(doc(db, collectionName, id));
}
