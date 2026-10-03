import { SymbolView } from 'expo-symbols';
import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';

import { AgentGroupField } from '@/components/agent-group-field';
import { CatalogFetchAlert } from '@/components/catalog-fetch-alert';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { DropdownField } from '@/components/dropdown-field';
import { InventoryStockModal } from '@/components/inventory-stock-modal';
import { Screen } from '@/components/screen';
import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useBreadTypes } from '@/context/bread-types';
import { useBusinessSettings } from '@/context/business-settings';
import { useCustomers } from '@/context/customers';
import { useInventory } from '@/context/inventory';
import { useReturnedBreadTypes } from '@/context/returned-bread-types';
import { useStock } from '@/context/stock';
import type { RefreshOptions } from '@/hooks/use-cached-catalog';
import { useTheme } from '@/hooks/use-theme';
import type { CatalogSourceKind } from '@/lib/catalog-source';
import { logError } from '@/lib/errors';
import { runWithRetry } from '@/lib/retry';

type CatalogKey = 'breadTypes' | 'returnedBreadTypes' | 'businessSettings' | 'customers';

type Catalog = {
  key: CatalogKey;
  label: string;
  /**
   * Called with `{ force: true }` — see `runFetch`. `refreshCustomers` takes no
   * arguments and doesn't need to: its pull has no in-flight request to ride
   * along on, so it already always goes.
   */
  refresh: (options?: RefreshOptions) => Promise<CatalogSourceKind>;
};

/** 'pending' while its request is in the air, then how that request ended. */
type FetchStatus = 'pending' | CatalogSourceKind;

const AllPending: Record<CatalogKey, FetchStatus> = {
  breadTypes: 'pending',
  returnedBreadTypes: 'pending',
  businessSettings: 'pending',
  customers: 'pending',
};

/**
 * One-time setup a truck's device must complete before the Inventory tab lets
 * it populate stock: which Area it serves, which Truck it is, and which Crew
 * is aboard. Shown by inventory.tsx until `setup.complete`.
 *
 * Stays the screen shown even after setup finishes — it just swaps the form
 * for a read-only summary plus "Edit Inventory Draft". Only the first saved
 * draft (stock.phase leaving 'empty') hands off to InventoryStockScreen, per
 * the original flow: finalize setup here, edit here, only the first Save
 * Changes moves you into the real inventory list.
 */
export function InventorySetup() {
  const theme = useTheme();
  const inventory = useInventory();
  const { breadTypes, refreshBreadTypes } = useBreadTypes();
  const { refreshReturnedBreadTypes } = useReturnedBreadTypes();
  const { refreshBusinessSettings } = useBusinessSettings();
  const { refreshCustomers } = useCustomers();
  const stock = useStock();
  const [modalVisible, setModalVisible] = useState(false);

  // 'form' → filling it in. 'fetching' → the finish-time downloads are running
  // (full-screen progress). 'failed' → at least one didn't come back and the
  // retry / use-saved-copy prompt is up over the form. 'opening' → the
  // downloads are done (or been waived) and the run is being written.
  const [phase, setPhase] = useState<'form' | 'fetching' | 'opening' | 'failed'>('form');
  const [statuses, setStatuses] = useState<Record<CatalogKey, FetchStatus>>(AllPending);
  const [failures, setFailures] = useState<{ key: CatalogKey; label: string; hasCache: boolean }[]>([]);
  const [confirmingFinish, setConfirmingFinish] = useState(false);

  const { setup } = inventory;
  const canFinish = !!setup.areaId && !!setup.truckId && !!setup.agentGroupId;

  // Pulled fresh right as the truck heads out, so the rest of the day starts
  // from a known-current copy of each instead of whatever happened to be
  // cached from whenever the app last opened. Adding another download means
  // adding a row here and nothing else — the progress list, the failure
  // prompt and the retry all read from this array.
  //
  // Only the ones the driver never sees a picker for. Area, truck and crews
  // are deliberately NOT here: each of those fetches when its own picker opens
  // (see context/inventory.tsx), so by the time Finish setup is pressed they
  // have already been as fresh as the signal allowed. Re-downloading them here
  // would gate finishing the day's setup on three lists the user just
  // successfully picked from.
  //
  // Stores are the odd one out and belong here for a different reason. They are
  // not dashboard-owned — every phone writes them — so this is the moment the
  // truck picks up the stores *other* agents added or corrected since it last
  // had signal. Doing it here rather than trusting the background pass means
  // the driver leaves the depot knowing the route list is current, and a
  // failure is said out loud instead of retried quietly all morning.
  const catalogs: Catalog[] = [
    { key: 'breadTypes', label: 'Bread types', refresh: refreshBreadTypes },
    { key: 'returnedBreadTypes', label: 'Return prices', refresh: refreshReturnedBreadTypes },
    { key: 'businessSettings', label: 'Business details', refresh: refreshBusinessSettings },
    { key: 'customers', label: 'Stores', refresh: refreshCustomers },
  ];

  /**
   * Opens the run, with a retry prompt if saving it fails.
   *
   * Both ways of finishing setup — every catalog came back fresh, or the user
   * chose "Use saved copy" — go through here, so the failure is handled once.
   * finalizeSetup only rejects when the run couldn't be written to disk, and a
   * run that isn't on disk is one whose whole day would be unable to upload, so
   * this is worth a real prompt rather than a log line.
   *
   * Resolves false if the run isn't open — the caller returns to the form.
   */
  async function openRun(): Promise<boolean> {
    const opened = await runWithRetry(() => inventory.finalizeSetup(), {
      scope: 'inventory.setup.finalize',
      title: 'Could not start the day',
      message: 'The truck setup was not saved, so no day has been started and nothing can be recorded against it yet.',
    });
    return opened.completed && opened.value;
  }

  /**
   * Opens the run behind the full-screen spinner, and drops back to the form if
   * it couldn't be opened — openRun has already said why.
   *
   * **Switching the phase first is the point.** Both callers previously awaited
   * openRun with the screen left exactly as it was, and finalizeSetup is not
   * instant: it probes Firestore for a free run number, which on the dead
   * signal that produced this prompt in the first place is a six-second wait.
   * From "Use saved copy" that meant the alert sat there, still on screen and
   * still tappable, for six seconds after being tapped — indistinguishable from
   * a press that didn't register.
   */
  async function finishOpeningRun() {
    setPhase('opening');
    if (!(await openRun())) setPhase('form');
  }

  /**
   * Downloads the given catalogs and, if every one of them came back fresh,
   * opens the run.
   *
   * **Every target is forced**, so finishing setup always makes a request of
   * its own rather than reporting on one already in the air (see
   * `RefreshOptions.force`). This is the moment the day's prices, return
   * prices, business details and store list are pinned down — for the stores
   * it is the only download they get all trip — and a driver who taps
   * "Start the day" is entitled to have the app actually ask. Riding along
   * meant a launch-time fetch a few seconds old could stand in for it, and a
   * launch-time fetch that timed out could fail a setup that was never
   * attempted. Retry forces for the same reason: a retry that re-reports an
   * old answer is not a retry.
   */
  async function runFetch(targets: Catalog[]) {
    setStatuses((current) => {
      const next = { ...current };
      for (const target of targets) next[target.key] = 'pending';
      return next;
    });
    setPhase('fetching');

    try {
      // Each request reports in as it lands, so the progress list fills in one
      // row at a time instead of everything flipping at the end.
      const results = await Promise.all(
        targets.map(async (target) => {
          const kind = await target.refresh({ force: true });
          setStatuses((current) => ({ ...current, [target.key]: kind }));
          return { target, kind };
        }),
      );

      const failed = results.filter((result) => result.kind !== 'fresh');
      if (failed.length === 0) {
        await finishOpeningRun();
        return;
      }

      setFailures(
        failed.map(({ target, kind }) => ({ key: target.key, label: target.label, hasCache: kind === 'cache' })),
      );
      setPhase('failed');
    } catch (error) {
      // refresh() is written to resolve rather than reject, so this is the
      // "can't happen" branch — but if it ever did, the screen would sit on
      // the full-screen progress spinner with no way forward. Treat it as
      // every target having failed with nothing cached, which lands the user
      // on the retry prompt.
      logError('inventory.setup.fetch', error);
      setFailures(targets.map((target) => ({ key: target.key, label: target.label, hasCache: false })));
      setPhase('failed');
    }
  }

  // Retry only re-fetches what actually failed; anything already fresh stays
  // fresh and keeps its row ticked in the progress list.
  function handleRetry() {
    void runFetch(catalogs.filter((catalog) => failures.some((failure) => failure.key === catalog.key)));
  }

  function handleConfirmFinish() {
    setConfirmingFinish(false);
    void runFetch(catalogs);
  }

  if (setup.complete) {
    const areaName = inventory.areas.find((a) => a.id === setup.areaId)?.name ?? '—';
    const truckName = inventory.trucks.find((t) => t.id === setup.truckId)?.name ?? '—';
    // Read from the run rather than from the crew list, because the run is
    // where the answer was pinned: it holds the names as they were when the
    // day started, and it is still right if the crews are re-fetched — or
    // edited on the dashboard — halfway through the trip.
    const crewName = inventory.currentRun?.agentGroupName || '—';
    const agentNames = inventory.currentRun?.agents.map((a) => a.name).join(', ') || '—';

    return (
      <Screen scroll>
        <ThemedText type="subtitle">This truck is set up</ThemedText>

        <View style={styles.summary}>
          <SummaryRow label="Area" value={areaName} />
          <SummaryRow label="Truck" value={truckName} />
          <SummaryRow label="Crew" value={crewName} />
          <SummaryRow label="Agents" value={agentNames} />
        </View>

        <Pressable
          onPress={() => setModalVisible(true)}
          style={({ pressed }) => [
            styles.finishButton,
            { backgroundColor: theme.accent, opacity: pressed ? 0.8 : 1 },
          ]}>
          <ThemedText type="smallBold" style={{ color: theme.background }}>
            Edit Inventory Draft
          </ThemedText>
        </Pressable>

        <InventoryStockModal
          visible={modalVisible}
          mode="set"
          breadTypes={breadTypes}
          currentStock={{}}
          onClose={() => setModalVisible(false)}
          onSave={stock.saveDraft}
        />
      </Screen>
    );
  }

  // The progress list stays up through 'opening' rather than being swapped for
  // a bare spinner: the rows are the record of what was downloaded and what was
  // waived, and they're worth keeping in front of the driver until the day
  // actually starts. Only the line above them changes.
  if (phase === 'fetching' || phase === 'opening') {
    return (
      <Screen>
        <View style={styles.finishingContainer}>
          <ActivityIndicator size="large" color={theme.textSecondary} />
          <ThemedText type="default" themeColor="textSecondary" style={styles.finishingLabel}>
            {phase === 'opening' ? 'Starting the day…' : 'Getting today’s prices and details…'}
          </ThemedText>
          <View style={styles.progressList}>
            {catalogs.map((catalog) => (
              <FetchStatusRow key={catalog.key} label={catalog.label} status={statuses[catalog.key]} />
            ))}
          </View>
        </View>
      </Screen>
    );
  }

  return (
    <Screen scroll>
      <ThemedText type="subtitle">Set up this truck</ThemedText>
      <ThemedText type="default" themeColor="textSecondary" style={styles.intro}>
        Complete this once per truck before adding inventory.
      </ThemedText>

      <View style={styles.form}>
        {/* All three lists are dashboard-owned and read-only here. There is no
            "Add new" any more: a truck typed into one phone used to get an id
            only that phone knew, which made it impossible to group anything
            uploaded by truck. Adding one is now the manager's job.

            Each fetches on open, and falls back to the saved copy in silence
            if the server doesn't answer — so opening a picker always shows the
            newest list this phone can get hold of. */}
        <DropdownField
          label="Area"
          placeholder="Select an area"
          options={inventory.areas.map((a) => ({ id: a.id, label: a.name }))}
          loading={inventory.areasLoading}
          errorText={inventory.areasError}
          onOpen={inventory.ensureAreasLoaded}
          value={setup.areaId}
          onChange={(areaId) => inventory.updateSetup({ areaId })}
        />

        <DropdownField
          label="Truck"
          placeholder="Select a truck"
          options={inventory.trucks.map((t) => ({ id: t.id, label: t.name }))}
          loading={inventory.trucksLoading}
          errorText={inventory.trucksError}
          onOpen={inventory.ensureTrucksLoaded}
          value={setup.truckId}
          onChange={(truckId) => inventory.updateSetup({ truckId })}
        />

        {/* Not a DropdownField: a crew is chosen as a whole, and the driver has
            to be able to see who is in it before committing to it. See
            agent-group-field.tsx. */}
        <AgentGroupField
          label="Crew"
          placeholder="Select a crew"
          groups={inventory.agentGroups}
          loading={inventory.agentGroupsLoading}
          errorText={inventory.agentGroupsError}
          onOpen={inventory.ensureAgentGroupsLoaded}
          value={setup.agentGroupId}
          onChange={(agentGroupId) => inventory.updateSetup({ agentGroupId })}
        />
      </View>

      <Pressable
        onPress={() => setConfirmingFinish(true)}
        disabled={!canFinish}
        style={({ pressed }) => [
          styles.finishButton,
          { backgroundColor: theme.text, opacity: !canFinish ? 0.4 : pressed ? 0.8 : 1 },
        ]}>
        <ThemedText type="smallBold" style={{ color: theme.background }}>
          Finish setup
        </ThemedText>
      </Pressable>

      {/* Asked before the downloads even start: once they succeed, the run is
          open and the day has started. Asking here, rather than after the
          fetch, means "Go back" costs the driver nothing — no run written,
          nothing to undo. */}
      <ConfirmDialog
        visible={confirmingFinish}
        title="Start the day?"
        message="Check the area, truck and crew above are right before continuing."
        cancelLabel="Go back"
        confirmLabel="Continue"
        onCancel={() => setConfirmingFinish(false)}
        onConfirm={handleConfirmFinish}
      />

      <CatalogFetchAlert
        visible={phase === 'failed'}
        failed={failures.map((failure) => failure.label)}
        canUseCache={failures.length > 0 && failures.every((failure) => failure.hasCache)}
        onRetry={handleRetry}
        onUseCache={() => void finishOpeningRun()}
        onDismiss={() => setPhase('form')}
      />
    </Screen>
  );
}

function FetchStatusRow({ label, status }: { label: string; status: FetchStatus }) {
  const theme = useTheme();

  const detail = {
    pending: { text: 'Downloading…', color: theme.textSecondary },
    fresh: { text: 'Up to date', color: theme.success },
    cache: { text: 'Saved copy', color: theme.warning },
    none: { text: 'Unavailable', color: theme.danger },
  }[status];

  return (
    <View style={styles.progressRow}>
      <View style={styles.progressIcon}>
        {status === 'pending' ? (
          <ActivityIndicator size="small" color={theme.textSecondary} />
        ) : (
          <SymbolView
            name={
              status === 'fresh'
                ? { ios: 'checkmark.circle.fill', android: 'check_circle', web: 'check_circle' }
                : status === 'cache'
                  ? { ios: 'exclamationmark.triangle.fill', android: 'warning', web: 'warning' }
                  : { ios: 'xmark.circle.fill', android: 'error', web: 'error' }
            }
            tintColor={detail.color}
            size={18}
          />
        )}
      </View>
      <ThemedText type="small" style={styles.progressLabel}>
        {label}
      </ThemedText>
      <ThemedText type="small" style={{ color: detail.color }}>
        {detail.text}
      </ThemedText>
    </View>
  );
}

/**
 * Label on the left, value on the right — and the value **wraps** rather than
 * running off the row.
 *
 * "Agents" is the reason: it's every crew member's name joined together, so it
 * is routinely longer than the line. It is deliberately not truncated with an
 * ellipsis the way the picker trigger is — this screen is the record of who is
 * on the truck today, and a name that's been cut in half is worse than a row
 * two lines tall.
 */
function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.summaryRow}>
      <ThemedText type="smallBold" themeColor="textSecondary" style={styles.summaryLabel}>
        {label}
      </ThemedText>
      <ThemedText type="default" style={styles.summaryValue}>
        {value}
      </ThemedText>
    </View>
  );
}

const styles = StyleSheet.create({
  finishingContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.three,
  },
  finishingLabel: {
    textAlign: 'center',
  },
  progressList: {
    alignSelf: 'stretch',
    gap: Spacing.two,
    marginTop: Spacing.two,
  },
  progressRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  // Fixed so the labels line up whether the row shows a spinner or an icon.
  progressIcon: {
    width: 18,
    alignItems: 'center',
  },
  progressLabel: {
    flex: 1,
  },
  intro: {
    marginTop: Spacing.one,
  },
  form: {
    gap: Spacing.three,
    marginTop: Spacing.four,
  },
  summary: {
    gap: Spacing.two,
    marginTop: Spacing.four,
  },
  summaryRow: {
    flexDirection: 'row',
    // flex-start, not center: once the value wraps to two or three lines the
    // label should stay on the first one rather than float to the middle.
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: Spacing.three,
  },
  // The label keeps its natural width; the value takes what's left and wraps
  // inside it. Without flexShrink: 0 a long value squeezes the label instead.
  summaryLabel: {
    flexShrink: 0,
  },
  summaryValue: {
    flex: 1,
    textAlign: 'right',
  },
  finishButton: {
    borderRadius: Spacing.two,
    paddingVertical: Spacing.three,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: Spacing.four,
  },
});
