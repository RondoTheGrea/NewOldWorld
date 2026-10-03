import { collection, getDocs, orderBy, query } from 'firebase/firestore';
import { createContext, use, type PropsWithChildren } from 'react';

import { useCachedCatalog, type RefreshOptions } from '@/hooks/use-cached-catalog';
import { assertFromServer, type CatalogSource, type CatalogSourceKind } from '@/lib/catalog-source';
import { db } from '@/lib/firebase';

const CACHE_KEY = 'breadTypes.cache.v1';

export type UnitLabel = 'tray' | 'box' | 'piece';

/**
 * The catalog of bread products the dashboard manages — name, price, and
 * packaging unit (e.g. "a tray holds 8 pieces"). Mobile is fetch-only here
 * (see firestore.rules); this is NOT stock — how many of each is on this
 * truck is a separate, later feature that reads from this list rather than
 * editing it.
 */
export type BreadType = {
  id: string;
  name: string;
  price: number;
  unitSize: number;
  unitLabel: UnitLabel;
  /** Manual display position set on the dashboard — lower shows first. */
  order: number;
};

type BreadTypesContextValue = {
  breadTypes: BreadType[];
  /** True only while fetching AND there's no cached data to show in the meantime. */
  breadTypesLoading: boolean;
  breadTypesError: string | null;
  /** Fresh from Firestore, or the saved copy — see lib/catalog-source.ts. */
  breadTypesSource: CatalogSource;
  /** Hits Firestore fresh; resolves with what the caller ended up with. */
  refreshBreadTypes: (options?: RefreshOptions) => Promise<CatalogSourceKind>;
};

const BreadTypesContext = createContext<BreadTypesContextValue | null>(null);

export function useBreadTypes() {
  const value = use(BreadTypesContext);
  if (!value) {
    throw new Error('useBreadTypes must be used inside a <BreadTypesProvider>');
  }
  return value;
}

// Firestore's own `orderBy('order')` would drop any doc that doesn't have the
// field yet, so the query still asks for name order (guaranteeing every doc
// comes back) and the real sort — by the dashboard-set `order` field — always
// happens here. Mobile is read-only on this collection (see firestore.rules),
// so unlike the dashboard it can't backfill a missing `order`; a stable sort
// just leaves those docs in the alphabetical order the query returned them in.
function sortByOrder(items: BreadType[]): BreadType[] {
  return [...items].sort((a, b) => a.order - b.order);
}

export function BreadTypesProvider({ children }: PropsWithChildren) {
  // All the fetch/cache/timeout/freshness behaviour lives in the hook — this
  // provider only says what to read and how to shape it.
  const catalog = useCachedCatalog<BreadType[]>({
    cacheKey: CACHE_KEY,
    initial: [],
    normalize: sortByOrder,
    // Bread types are what every other screen is drawn from — the inventory
    // list, "Add batch", the receipt form. An empty answer here doesn't degrade
    // the app, it empties it, so a saved copy is never given up for one. See
    // `isEmpty` in the hook.
    isEmpty: (items) => items.length === 0,
    errorMessage: 'Could not load bread types. Check your connection and try again.',
    fetch: async () => {
      const snapshot = await getDocs(query(collection(db, 'breadTypes'), orderBy('name')));
      assertFromServer(snapshot.metadata);
      const datas = snapshot.docs.map((d) => d.data());
      return snapshot.docs.map((d, index) => ({
        id: d.id,
        name: (datas[index].name as string) ?? '',
        price: (datas[index].price as number) ?? 0,
        unitSize: (datas[index].unitSize as number) ?? 1,
        unitLabel: (datas[index].unitLabel as UnitLabel) ?? 'piece',
        order: (datas[index].order as number) ?? 0,
      }));
    },
  });

  const value: BreadTypesContextValue = {
    breadTypes: catalog.value,
    breadTypesLoading: catalog.loading,
    breadTypesError: catalog.error,
    breadTypesSource: catalog.source,
    refreshBreadTypes: catalog.refresh,
  };

  return <BreadTypesContext value={value}>{children}</BreadTypesContext>;
}
