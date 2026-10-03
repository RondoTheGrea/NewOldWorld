import { doc, getDoc } from 'firebase/firestore';
import { createContext, use, type PropsWithChildren } from 'react';

import { DefaultBusinessSettings } from '@/constants/business';
import { useCachedCatalog, type RefreshOptions } from '@/hooks/use-cached-catalog';
import { assertFromServer, type CatalogSource, type CatalogSourceKind } from '@/lib/catalog-source';
import { db } from '@/lib/firebase';

const CACHE_KEY = 'businessSettings.cache.v1';

/**
 * Business name, contact number, and receipt ending message — edited from
 * the dashboard's Settings page (a single Firestore doc, settings/business),
 * printed on every receipt. See apps/mobile/src/lib/receipt-print.ts.
 */
export type BusinessSettings = {
  name: string;
  contactNumber: string;
  receiptEndingMessage: string;
};

type BusinessSettingsContextValue = {
  businessSettings: BusinessSettings;
  /** True only while fetching AND there's no cached data to show in the meantime. */
  businessSettingsLoading: boolean;
  businessSettingsError: string | null;
  /** Fresh from Firestore, or the saved copy — see lib/catalog-source.ts. */
  businessSettingsSource: CatalogSource;
  /** Hits Firestore fresh; resolves with what the caller ended up with. */
  refreshBusinessSettings: (options?: RefreshOptions) => Promise<CatalogSourceKind>;
};

const BusinessSettingsContext = createContext<BusinessSettingsContextValue | null>(null);

export function useBusinessSettings() {
  const value = use(BusinessSettingsContext);
  if (!value) {
    throw new Error('useBusinessSettings must be used inside a <BusinessSettingsProvider>');
  }
  return value;
}

export function BusinessSettingsProvider({ children }: PropsWithChildren) {
  // One doc rather than a collection, but the same fetch/cache/freshness
  // behaviour as the two catalogs — see hooks/use-cached-catalog.ts.
  const catalog = useCachedCatalog<BusinessSettings>({
    cacheKey: CACHE_KEY,
    initial: DefaultBusinessSettings,
    errorMessage: 'Could not load business settings. Check your connection and try again.',
    fetch: async () => {
      const snapshot = await getDoc(doc(db, 'settings', 'business'));
      assertFromServer(snapshot.metadata);
      // A missing doc is a real answer, not a failure: the dashboard simply
      // hasn't filled Settings in yet, so the defaults *are* current.
      if (!snapshot.exists()) return DefaultBusinessSettings;
      const data = snapshot.data();
      return {
        name: (data.name as string) ?? DefaultBusinessSettings.name,
        contactNumber: (data.contactNumber as string) ?? DefaultBusinessSettings.contactNumber,
        receiptEndingMessage: (data.receiptEndingMessage as string) ?? DefaultBusinessSettings.receiptEndingMessage,
      };
    },
  });

  const value: BusinessSettingsContextValue = {
    businessSettings: catalog.value,
    businessSettingsLoading: catalog.loading,
    businessSettingsError: catalog.error,
    businessSettingsSource: catalog.source,
    refreshBusinessSettings: catalog.refresh,
  };

  return <BusinessSettingsContext value={value}>{children}</BusinessSettingsContext>;
}
