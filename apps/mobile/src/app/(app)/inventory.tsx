import { StyleSheet, View } from 'react-native';

import { CatalogSourceIndicator } from '@/components/catalog-source-indicator';
import { ErrorBoundary } from '@/components/error-boundary';
import { InventorySetup } from '@/components/inventory-setup';
import { InventoryStockScreen } from '@/components/inventory-stock-screen';
import { Screen } from '@/components/screen';
import { useInventory } from '@/context/inventory';
import { useStock } from '@/context/stock';

// Boundary per tab, so a crash here can't take the rest of the app with it.
export default function InventoryScreen() {
  return (
    <ErrorBoundary label="Inventory">
      <InventoryScreenContent />
    </ErrorBoundary>
  );
}

function InventoryScreenContent() {
  const { setupLoading, setup } = useInventory();
  const stock = useStock();

  // Blank until we know which screen is correct — never the wrong one first.
  // Mirrors the `if (initializing) return null` gate in src/app/_layout.tsx.
  // InventorySetup stays on screen through the first save: truck setup done,
  // then "Edit Inventory Draft" right there, then the first Save Changes is
  // what hands off to the real inventory list — not truck setup finishing.
  // stock.stockError (e.g. web, where SQLite isn't available) always routes
  // to InventoryStockScreen instead, since that's where the error message lives.
  const loading = setupLoading || stock.stockLoading;
  const setupPending = !setup.complete || (stock.phase === 'empty' && !stock.stockError);
  const content = loading ? <Screen /> : setupPending ? <InventorySetup /> : <InventoryStockScreen />;

  // The freshness strip is a sibling below the screen (the same relationship
  // the tab bar has to it), so the inventory screen keeps its full height
  // above it and doesn't have to make room by hand.
  //
  // It only appears once the real inventory list is up. While loading or on
  // truck setup there is nothing on screen priced from those catalogs yet, so
  // a "saved copy" line there would be answering a question nobody asked —
  // and setup has its own, louder way of reporting a failed download
  // (components/catalog-fetch-alert.tsx).
  return (
    <View style={styles.fill}>
      {content}
      {!loading && !setupPending ? <CatalogSourceIndicator /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
  },
});
