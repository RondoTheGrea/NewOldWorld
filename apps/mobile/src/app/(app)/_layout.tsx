import { Tabs } from 'expo-router/js-tabs';
import { SymbolView, type SymbolViewProps } from 'expo-symbols';
import { type ColorValue } from 'react-native';

import { BreadTypesProvider } from '@/context/bread-types';
import { BusinessSettingsProvider } from '@/context/business-settings';
import { CustomersProvider } from '@/context/customers';
import { ExpensesProvider } from '@/context/expenses';
import { InventoryProvider } from '@/context/inventory';
import { PrinterProvider } from '@/context/printer';
import { ReceiptsProvider } from '@/context/receipts';
import { ReturnedBreadTypesProvider } from '@/context/returned-bread-types';
import { RunHistoryProvider } from '@/context/run-history';
import { StockProvider } from '@/context/stock';
import { SyncProvider } from '@/context/sync';
import { useTheme } from '@/hooks/use-theme';

/**
 * One icon per tab, drawn from the OS symbol sets via expo-symbols: SF Symbols
 * on iOS, Material Symbols on Android and web. No icon files to ship.
 */
function tabIcon(name: SymbolViewProps['name']) {
  return function TabIcon({ color, size }: { color: ColorValue; size: number }) {
    return <SymbolView name={name} tintColor={color} size={size} />;
  };
}

// Everything under (app) is only reachable once a user is logged in — the auth
// guard in the root layout (src/app/_layout.tsx) enforces that.
//
// These are JS tabs (expo-router/js-tabs) rather than the native ones, so
// Android, iOS and the web build all run the same single implementation. The
// navigator lays the tab bar out as a sibling below the screen, which is what
// keeps content from ever running underneath it — see src/components/screen.tsx.
export default function AppLayout() {
  const theme = useTheme();

  return (
    <CustomersProvider>
      <InventoryProvider>
        <BreadTypesProvider>
          <ReturnedBreadTypesProvider>
            <BusinessSettingsProvider>
              {/* SyncProvider sits below InventoryProvider because it reads the
                  setup (which run this phone is on) and the truck/agent
                  names it stamps onto every upload. Nothing needs to sit below
                  *it*: the other contexts nudge sync through a module-level
                  hook in lib/sync.ts, not through this context. */}
              <SyncProvider>
                <StockProvider>
                  <ReceiptsProvider>
                    {/* Reads the open run from InventoryProvider and nudges the
                        sync loop through lib/sync.ts's module-level hook, so
                        nothing has to sit below it. */}
                    <ExpensesProvider>
                    <RunHistoryProvider>
                    <PrinterProvider>
                      <Tabs
                        screenOptions={{
                        // Screens draw their own top area through <Screen>.
                        headerShown: false,
                        tabBarActiveTintColor: theme.text,
                        tabBarInactiveTintColor: theme.textSecondary,
                        tabBarStyle: {
                          backgroundColor: theme.background,
                          // The divider between the screen and the tabs. A full 1px rather than
                          // a hairline — on a white theme there's no shadow to imply the edge,
                          // and a hairline is a third of a pixel on a high-density phone, which
                          // reads as nothing at all.
                          borderTopWidth: 2,
                          borderTopColor: theme.border,
                          // Android otherwise stacks its own drop shadow on top of the line.
                          elevation: 0,
                        },
                      }}>
                      <Tabs.Screen
                        name="index"
                        options={{
                          title: 'Home',
                          tabBarIcon: tabIcon({ ios: 'house.fill', android: 'home', web: 'home' }),
                        }}
                      />
                      <Tabs.Screen
                        name="inventory"
                        options={{
                          title: 'Inventory',
                          tabBarIcon: tabIcon({
                            ios: 'shippingbox.fill',
                            android: 'inventory_2',
                            web: 'inventory_2',
                          }),
                        }}
                      />
                      <Tabs.Screen
                        name="receipts"
                        options={{
                          title: 'Receipts',
                          tabBarIcon: tabIcon({
                            ios: 'doc.text.fill',
                            android: 'receipt_long',
                            web: 'receipt_long',
                          }),
                        }}
                      />
                      <Tabs.Screen
                        name="customers"
                        options={{
                          title: 'Customers',
                          tabBarIcon: tabIcon({ ios: 'person.2.fill', android: 'group', web: 'group' }),
                        }}
                      />
                      </Tabs>
                    </PrinterProvider>
                    </RunHistoryProvider>
                    </ExpensesProvider>
                  </ReceiptsProvider>
                </StockProvider>
              </SyncProvider>
            </BusinessSettingsProvider>
          </ReturnedBreadTypesProvider>
        </BreadTypesProvider>
      </InventoryProvider>
    </CustomersProvider>
  );
}
