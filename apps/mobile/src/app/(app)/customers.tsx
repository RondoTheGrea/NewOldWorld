import { SymbolView } from 'expo-symbols';
import { useMemo, useState } from 'react';
import { FlatList, Platform, Pressable, StyleSheet, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CustomerCard } from '@/components/customer-card';
import { CustomerDetailModal } from '@/components/customer-detail-modal';
import { CustomerFormModal } from '@/components/customer-form-modal';
import { ErrorBoundary } from '@/components/error-boundary';
import { Screen } from '@/components/screen';
import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useCustomers, type Customer, type CustomerInput } from '@/context/customers';
import { useTheme } from '@/hooks/use-theme';
import { generateId } from '@/lib/id';
import { runWithRetry } from '@/lib/retry';

// Boundary per tab, so a crash here can't take the rest of the app with it.
export default function CustomersScreen() {
  return (
    <ErrorBoundary label="Customers">
      <CustomersScreenContent />
    </ErrorBoundary>
  );
}

function CustomersScreenContent() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { customers, loading, error, reloadCustomers, addCustomer, updateCustomer, deleteCustomer } = useCustomers();
  const [selected, setSelected] = useState<Customer | null>(null);
  const [formState, setFormState] = useState<{ visible: boolean; editing: Customer | null }>({
    visible: false,
    editing: null,
  });
  const [query, setQuery] = useState('');

  const normalizedQuery = query.trim().toLowerCase();
  const filteredCustomers = useMemo(() => {
    if (!normalizedQuery) return customers;
    const words = normalizedQuery.split(/\s+/);
    return customers.filter((customer) => {
      const storeName = customer.storeName.toLowerCase();
      const name = customer.name.toLowerCase();
      return words.every((word) => storeName.includes(word) || name.includes(word));
    });
  }, [customers, normalizedQuery]);

  if (loading) {
    return <Screen />;
  }

  if (error) {
    return (
      <Screen scroll>
        <View style={styles.errorState}>
          <ThemedText type="default" themeColor="textSecondary" style={styles.errorText}>
            {error}
          </ThemedText>
          <Pressable
            onPress={reloadCustomers}
            style={({ pressed }) => [styles.retryButton, { borderColor: theme.accent, opacity: pressed ? 0.6 : 1 }]}>
            <ThemedText type="smallBold" style={{ color: theme.accent }}>
              Try again
            </ThemedText>
          </Pressable>
        </View>
      </Screen>
    );
  }

  function openAddForm() {
    setSelected(null);
    setFormState({ visible: true, editing: null });
  }

  function openEditForm(customer: Customer) {
    setSelected(null);
    setFormState({ visible: true, editing: customer });
  }

  function closeForm() {
    setFormState({ visible: false, editing: null });
  }

  /** Resolves true only once the customer is genuinely saved — the form stays open otherwise. */
  async function handleSubmit(input: CustomerInput): Promise<boolean> {
    const editing = formState.editing;
    // Minted once per press of Save, outside the retry loop, so every "Try
    // again" writes the same store rather than adding another one. Editing
    // needs no equivalent: updateCustomer sets fixed values on a known row, so
    // repeating it is the same as doing it once.
    const newCustomerId = generateId();
    const result = await runWithRetry(async () => {
      if (editing) await updateCustomer(editing.id, input);
      else await addCustomer(input, newCustomerId);
    }, {
      scope: editing ? 'customers.update' : 'customers.add',
      title: editing ? 'Could not save the changes' : 'Could not add the customer',
      message: editing ? 'This customer is unchanged.' : 'The customer was not added.',
    });
    return result.completed;
  }

  async function handleDelete(customer: Customer) {
    const result = await runWithRetry(() => deleteCustomer(customer.id), {
      scope: 'customers.delete',
      title: 'Could not delete the customer',
      message: `${customer.storeName} is still here — nothing was deleted.`,
    });
    if (result.completed) setSelected(null);
  }

  return (
    <Screen style={styles.screen}>
      <View style={styles.header}>
        <View
          style={[styles.searchBar, { backgroundColor: theme.backgroundElement, borderColor: theme.border }]}>
          <SymbolView
            name={{ ios: 'magnifyingglass', android: 'search', web: 'search' }}
            tintColor={theme.textSecondary}
            size={16}
          />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Search customers"
            placeholderTextColor={theme.textSecondary}
            style={[styles.searchInput, { color: theme.text }]}
            autoCorrect={false}
            autoCapitalize="none"
            returnKeyType="search"
            clearButtonMode="while-editing"
          />
          {query.length > 0 && (
            <Pressable
              onPress={() => setQuery('')}
              accessibilityRole="button"
              accessibilityLabel="Clear search"
              hitSlop={Spacing.two}>
              <SymbolView
                name={{ ios: 'xmark.circle.fill', android: 'close', web: 'close' }}
                tintColor={theme.textSecondary}
                size={16}
              />
            </Pressable>
          )}
        </View>

        <Pressable
          onPress={openAddForm}
          accessibilityRole="button"
          accessibilityLabel="Add customer"
          style={({ pressed }) => [
            styles.addButton,
            { backgroundColor: theme.text, opacity: pressed ? 0.8 : 1 },
          ]}>
          <SymbolView name={{ ios: 'plus', android: 'add', web: 'add' }} tintColor={theme.background} size={20} />
        </Pressable>
      </View>

      <FlatList
        data={filteredCustomers}
        keyExtractor={(customer) => customer.id}
        numColumns={2}
        // `<Screen>` pads every child alike, which insets this list's own
        // native scroll indicator right along with the cards. Canceling that
        // padding here and reapplying it as content padding instead moves
        // only the indicator — to the true right edge of the screen — while
        // the cards inside keep the exact same margins they had before.
        style={[styles.list, { marginLeft: -(insets.left + Spacing.four), marginRight: -(insets.right + Spacing.four) }]}
        contentContainerStyle={[
          styles.listContent,
          { paddingLeft: insets.left + Spacing.four, paddingRight: insets.right + Spacing.four },
        ]}
        columnWrapperStyle={styles.gridRow}
        keyboardShouldPersistTaps="handled"
        initialNumToRender={20}
        maxToRenderPerBatch={20}
        windowSize={7}
        removeClippedSubviews={Platform.OS !== 'web'}
        renderItem={({ item }) => (
          <View style={styles.gridItem}>
            <CustomerCard customer={item} onPress={() => setSelected(item)} />
          </View>
        )}
        ListEmptyComponent={
          <ThemedText type="default" themeColor="textSecondary" style={styles.empty}>
            {customers.length === 0
              ? 'No customers yet. Tap + to add your first one.'
              : 'No customers match your search.'}
          </ThemedText>
        }
      />

      <CustomerDetailModal
        customer={selected}
        onClose={() => setSelected(null)}
        onEdit={openEditForm}
        onDelete={handleDelete}
      />

      <CustomerFormModal
        visible={formState.visible}
        editing={formState.editing}
        onClose={closeForm}
        onSubmit={handleSubmit}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  errorState: {
    alignItems: 'center',
    gap: Spacing.three,
    marginTop: Spacing.five,
  },
  errorText: {
    textAlign: 'center',
  },
  retryButton: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: Spacing.two,
    paddingVertical: Spacing.three,
    paddingHorizontal: Spacing.four,
    alignItems: 'center',
    justifyContent: 'center',
  },
  screen: {
    paddingBottom: 0,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    marginBottom: Spacing.three,
  },
  searchBar: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    height: 50,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 22,
    paddingHorizontal: Spacing.three,
  },
  searchInput: {
    flex: 1,
    fontSize: 15,
    paddingVertical: 0,
  },
  addButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  empty: {
    marginTop: Spacing.four,
    textAlign: 'center',
  },
  list: {
    flex: 1,
  },
  listContent: {
    paddingBottom: Spacing.four,
  },
  gridRow: {
    justifyContent: 'space-between',
    marginBottom: Spacing.three,
  },
  gridItem: {
    width: '48%',
  },
});
