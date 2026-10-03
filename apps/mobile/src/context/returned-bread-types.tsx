import { collection, getDocs, orderBy, query } from 'firebase/firestore';
import { createContext, use, type PropsWithChildren } from 'react';

import type { UnitLabel } from '@/context/bread-types';
import { useCachedCatalog, type RefreshOptions } from '@/hooks/use-cached-catalog';
import { assertFromServer, type CatalogSource, type CatalogSourceKind } from '@/lib/catalog-source';
import { db } from '@/lib/firebase';

const CACHE_KEY = 'returnedBreadTypes.cache.v1';

/**
 * A price snapshot for bread that was sold before a price change and may
 * still come back as a return — see firebase/firestore.rules and
 * apps/web/src/lib/returned-bread-types.ts. Deliberately NOT linked to a
 * breadTypes id: it's a standalone name+price+unit entry a manager types in
 * by hand, used only to price a return line on a receipt (write-off against
 * the total). It never affects truck stock.
 */
export type ReturnedBreadType = {
  id: string;
  name: string;
  price: number;
  unitSize: number;
  unitLabel: UnitLabel;
  /** Manual display position set on the dashboard — lower shows first. */
  order: number;
};

type ReturnedBreadTypesContextValue = {
  returnedBreadTypes: ReturnedBreadType[];
  /** True only while fetching AND there's no cached data to show in the meantime. */
  returnedBreadTypesLoading: boolean;
  returnedBreadTypesError: string | null;
  /** Fresh from Firestore, or the saved copy — see lib/catalog-source.ts. */
  returnedBreadTypesSource: CatalogSource;
  /** Hits Firestore fresh; resolves with what the caller ended up with. */
  refreshReturnedBreadTypes: (options?: RefreshOptions) => Promise<CatalogSourceKind>;
};

const ReturnedBreadTypesContext = createContext<ReturnedBreadTypesContextValue | null>(null);

export function useReturnedBreadTypes() {
  const value = use(ReturnedBreadTypesContext);
  if (!value) {
    throw new Error('useReturnedBreadTypes must be used inside a <ReturnedBreadTypesProvider>');
  }
  return value;
}

// See sortByOrder in context/bread-types.tsx for why the query still orders
// by name and the real sort — by the dashboard-set `order` field — happens
// here instead.
function sortByOrder(items: ReturnedBreadType[]): ReturnedBreadType[] {
  return [...items].sort((a, b) => a.order - b.order);
}

export function ReturnedBreadTypesProvider({ children }: PropsWithChildren) {
  // Same shape as context/bread-types.tsx, pointed at the returnedBreadTypes
  // collection; the shared hook owns fetch, cache and freshness tracking.
  const catalog = useCachedCatalog<ReturnedBreadType[]>({
    cacheKey: CACHE_KEY,
    initial: [],
    normalize: sortByOrder,
    // Without this, an offline launch silently wipes the saved copy. A
    // `getDocs` with no signal does NOT reject — the SDK falls back to its own
    // (empty, in a fresh process) local cache and resolves a perfectly
    // well-formed snapshot with zero documents. The hook would take that at
    // face value: report `'fresh'`, replace the list with `[]`, and write `[]`
    // to disk, where it outlives the trip. So the returns section came up
    // empty and setup never even offered the saved copy, because nothing had
    // reported a failure. See `isEmpty` in the hook.
    isEmpty: (items) => items.length === 0,
    errorMessage: 'Could not load returned bread types. Check your connection and try again.',
    fetch: async () => {
      const snapshot = await getDocs(query(collection(db, 'returnedBreadTypes'), orderBy('name')));
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

  const value: ReturnedBreadTypesContextValue = {
    returnedBreadTypes: catalog.value,
    returnedBreadTypesLoading: catalog.loading,
    returnedBreadTypesError: catalog.error,
    returnedBreadTypesSource: catalog.source,
    refreshReturnedBreadTypes: catalog.refresh,
  };

  return <ReturnedBreadTypesContext value={value}>{children}</ReturnedBreadTypesContext>;
}
