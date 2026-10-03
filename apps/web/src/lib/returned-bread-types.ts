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
import type { UnitLabel } from '@/lib/bread-types';

/**
 * A price snapshot for bread that was sold before a price change and may
 * still come back as a return. Kept as its own collection (not a field on
 * breadTypes) so that updating a bread type's current price never touches
 * these — a return gets deducted at whatever price it actually sold for.
 */
export type ReturnedBreadType = {
  id: string;
  name: string;
  price: number;
  unitSize: number;
  unitLabel: UnitLabel;
  /** Manual display position, independent of breadTypes' own order field. */
  order: number;
};

export type ReturnedBreadTypeInput = Omit<ReturnedBreadType, 'id'>;

const returnedBreadTypesCollection = collection(db, 'returnedBreadTypes');

/**
 * Live-subscribes to the returned-bread list, sorted by the manual `order`
 * field — see watchBreadTypes in bread-types.ts for why the query itself
 * still orders by name and the backfill/sort happens here. Returns the
 * unsubscribe fn.
 */
export function watchReturnedBreadTypes(
  callback: (returnedBreadTypes: ReturnedBreadType[]) => void,
  onError?: (error: Error) => void,
) {
  const q = query(returnedBreadTypesCollection, orderBy('name'));
  return onSnapshot(q, (snapshot) => {
    const returnedBreadTypes = snapshot.docs.map((d, index) => {
      const data = d.data();
      const hasOrder = typeof data.order === 'number';
      const order = hasOrder ? (data.order as number) : index;
      if (!hasOrder) {
        void updateDoc(doc(db, 'returnedBreadTypes', d.id), { order });
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
    callback([...returnedBreadTypes].sort((a, b) => a.order - b.order));
  }, onError);
}

export async function addReturnedBreadType(input: ReturnedBreadTypeInput) {
  await addDoc(returnedBreadTypesCollection, {
    ...input,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
}

export async function updateReturnedBreadType(id: string, input: ReturnedBreadTypeInput) {
  await updateDoc(doc(db, 'returnedBreadTypes', id), {
    ...input,
    updatedAt: serverTimestamp(),
  });
}

export async function deleteReturnedBreadType(id: string) {
  await deleteDoc(doc(db, 'returnedBreadTypes', id));
}
