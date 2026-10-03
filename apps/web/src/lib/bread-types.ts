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

export type UnitLabel = 'tray' | 'box' | 'piece';

/**
 * The catalog of bread products the business sells — name, price, and how
 * it's packaged (e.g. "a tray holds 8 pieces"). This is NOT stock: it holds
 * no quantity. How many of each is on a given truck is a separate concern
 * the mobile app owns once a driver reports what they loaded.
 */
export type BreadType = {
  id: string;
  name: string;
  price: number;
  unitSize: number;
  unitLabel: UnitLabel;
  /** Manual display position (dashboard + app show this order, not alphabetical). */
  order: number;
};

export type BreadTypeInput = Omit<BreadType, 'id'>;

const breadTypesCollection = collection(db, 'breadTypes');

/**
 * Live-subscribes to the catalog, sorted by the manual `order` field. The
 * underlying query still asks Firestore for name order — `orderBy('order')`
 * would silently drop any doc that doesn't have the field yet, which is
 * exactly the docs that predate this feature. Instead every doc is read,
 * missing `order` is backfilled here to its current alphabetical position
 * (a one-time, self-healing write), and the real sort happens client-side.
 * Returns the unsubscribe fn.
 */
export function watchBreadTypes(
  callback: (breadTypes: BreadType[]) => void,
  onError?: (error: Error) => void,
) {
  const q = query(breadTypesCollection, orderBy('name'));
  return onSnapshot(q, (snapshot) => {
    const breadTypes = snapshot.docs.map((d, index) => {
      const data = d.data();
      const hasOrder = typeof data.order === 'number';
      const order = hasOrder ? (data.order as number) : index;
      if (!hasOrder) {
        void updateDoc(doc(db, 'breadTypes', d.id), { order });
      }
      return {
        id: d.id,
        name: (data.name as string) ?? '',
        price: (data.price as number) ?? 0,
        unitSize: (data.unitSize as number) ?? 1,
        unitLabel: (data.unitLabel as UnitLabel) ?? 'piece',
        order,
      };
    });
    callback([...breadTypes].sort((a, b) => a.order - b.order));
  }, onError);
}

export async function addBreadType(input: BreadTypeInput) {
  await addDoc(breadTypesCollection, {
    ...input,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
}

export async function updateBreadType(id: string, input: BreadTypeInput) {
  await updateDoc(doc(db, 'breadTypes', id), {
    ...input,
    updatedAt: serverTimestamp(),
  });
}

export async function deleteBreadType(id: string) {
  await deleteDoc(doc(db, 'breadTypes', id));
}

/** e.g. "Tray of 8" / "Box of 12" / "Piece" — used in the list and confirm dialogs. */
export function formatUnit(unitSize: number, unitLabel: UnitLabel): string {
  if (unitLabel === 'piece') return 'Piece';
  const label = unitLabel === 'tray' ? 'Tray' : 'Box';
  return `${label} of ${unitSize}`;
}
