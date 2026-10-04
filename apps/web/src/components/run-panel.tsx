import { useEffect, useMemo, useRef, useState } from 'react';

import { ReceiptTag } from '@/components/payment-tag';
import { ReceiptDetailPanel } from '@/components/receipt-detail-panel';

import { businessDayKey, formatBusinessDayShort, formatBusinessTime, formatDuration } from '@/lib/business-day';
import { type BreadType } from '@/lib/bread-types';
import { buildNameFor, buildOutcomeRows } from '@/lib/run-outcome';
import { type ReturnedBreadType } from '@/lib/returned-bread-types';
import {
  countBusinessDays,
  describeRunEnd,
  formatCount,
  formatMoney,
  runAgentNames,
  runEndDay,
  runSpansDays,
  totalExpenses,
  totalReceipts,
  totalStock,
  type Run,
  type RunExpense,
  type RunReceipt,
  type RunStockEntry,
} from '@/lib/runs';

/**
 * One run, opened.
 *
 * A live view of the run — what the truck has sold so far, what the ledger
 * says is still aboard, and the receipts as they land — whether the run is
 * still open or has ended.
 *
 * Everything is read-only. `firestore.rules` refuses any write to a run from an
 * account that didn't create it, which is every dashboard account — a wrong
 * number here is wrong on the truck and has to be fixed there.
 */

/** How many receipts the feed shows before offering the rest. */
const FeedPreviewCount = 12;

export function RunPanel({
  run,
  tripNumber,
  receipts,
  entries,
  expenses,
  breadTypes,
  returnedBreadTypes,
  now,
  onClose,
}: {
  run: Run;
  /**
   * Which trip of the day this is for these agents, counted across the whole
   * day by the board. Only the exported file name uses it — two runs by the same people on
   * one day would otherwise download under the same name.
   */
  tripNumber: number;
  /**
   * This run's records, or `null` while they are still arriving. Handed down
   * from the board rather than subscribed to here: the board already watches
   * every run of the day, and opening a panel that re-subscribed to the same
   * two collections would double the listeners to show the same rows.
   */
  receipts: RunReceipt[] | null;
  entries: RunStockEntry[] | null;
  /** This run's expenses, or `null` while they are still arriving — same contract as the two above. */
  expenses: RunExpense[] | null;
  /**
   * The bread catalog, already in the dashboard's own manual order (see
   * `watchBreadTypes`). Both the order and the names are used: the Inventory
   * and Outcome tables list bread the way the catalog lists it.
   */
  breadTypes: BreadType[];
  /**
   * The old-price catalog, in its own manual order. The Outcome table needs it
   * for the returns it folds in: a return names a bread that no current bread
   * type may be named after, and this is the only list that can place such a
   * row instead of dropping it at the bottom.
   */
  returnedBreadTypes: ReturnedBreadType[];
  /** A clock that ticks about once a minute, so "out for 3h 12m" stays true. */
  now: number;
  onClose: () => void;
}) {
  /**
   * Drives the drawer's slide-in-from-the-right / fade-in-scrim, and the
   * reverse on the way out. Starts `false` so the very first render paints the
   * closed position — the effect below flips it a frame later, which is what
   * gives the opening transition something to animate from. `requestClose`
   * (used by the ✕, the scrim and Escape, in place of calling `onClose`
   * directly) flips it back and only calls the real `onClose` — which
   * unmounts this component from the board — once that reverse transition
   * finishes, via `transitionend` with a timeout fallback for the case where
   * there's nothing to animate. Without the delay the panel would vanish the
   * instant it's dismissed while the scrim and the rest of the drawer's own
   * open/close motion (see .ops-panel-drawer / .ops-panel-scrim) would have
   * nothing left to play against.
   */
  const [visible, setVisible] = useState(false);
  const drawerRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const id = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(id);
  }, []);

  const requestClose = () => {
    setVisible(false);
    const el = drawerRef.current;
    if (!el) {
      onClose();
      return;
    }
    let settled = false;
    const finish = (event?: TransitionEvent) => {
      if (event && event.propertyName !== 'transform') return;
      if (settled) return;
      settled = true;
      el.removeEventListener('transitionend', finish);
      window.clearTimeout(fallback);
      onClose();
    };
    el.addEventListener('transitionend', finish);
    const fallback = window.setTimeout(finish, 320);
  };

  const [showAllReceipts, setShowAllReceipts] = useState(false);
  /**
   * Which receipt is open on the left, held as an **id** rather than the row
   * itself. These rows arrive from a live listener, so a receipt edited on the
   * truck while someone is reading it re-renders with the new figures instead
   * of leaving a stale copy pinned open.
   */
  const [openReceiptId, setOpenReceiptId] = useState<string | null>(null);
  /** Which of the five activity tables is showing. Receipts first — it's the one read most. */
  const [activityTab, setActivityTab] = useState<'receipts' | 'inventory' | 'outcome' | 'collected' | 'expenses'>(
    'receipts',
  );
  /** Agents/times/who's-signed-in and the run id — closed by default, since
   * nobody opens a run to read these; they're there for the one time someone
   * does. */
  const [detailsOpen, setDetailsOpen] = useState(false);
  /** Whether the Inventory table's headings show when each load went on.
   * Hidden by default — the counts are what the table is read for — and one
   * click on the heading row shows them, one more hides them again. */
  const [showLoadTimes, setShowLoadTimes] = useState(false);
  const [exporting, setExporting] = useState(false);
  /** Why the last export failed, shown under the Export button in the page's
   * own red notice rather than a browser alert. Cleared by the next attempt
   * and by opening another run. */
  const [exportError, setExportError] = useState<string | null>(null);
  /** The drawer's own scrolling element — see the effect and toggleDetails below. */
  const drawerBodyRef = useRef<HTMLDivElement>(null);
  /** Where the drawer was scrolled to right before "Run details" opened, so
   * collapsing it can scroll back there instead of just picking a spot. */
  const preOpenScrollTop = useRef(0);

  useEffect(() => {
    setShowAllReceipts(false);
    setOpenReceiptId(null);
    setActivityTab('receipts');
    setDetailsOpen(false);
    setShowLoadTimes(false);
    setExportError(null);
  }, [run.id]);

  // Opening "Run details" moves the drawer to the bottom of its own scroll,
  // since that section — and the run id under it — sits below everything
  // else and can otherwise open off-screen with nothing to show it happened.
  // Runs after the DOM has the new content, not from the click handler
  // itself, so scrollHeight already includes what just expanded. Skipped on
  // the way to closed: toggleDetails handles that direction itself, scrolling
  // *before* the section unmounts rather than after, which closed has no
  // scrollHeight left to scroll back down to.
  useEffect(() => {
    if (!detailsOpen) return;
    const el = drawerBodyRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [detailsOpen]);

  /**
   * The same motion in both directions. Opening mounts the section first (off
   * -screen below the fold) and then scrolls down to reveal it — closing has
   * to run that in reverse, scrolling back up *before* the section is removed,
   * or the content vanishing out from under the scroll position would just
   * snap the drawer upward instead of sliding.
   *
   * `scrollend` doesn't fire when there's nothing to scroll (already at the
   * target), so the section is removed on a timeout too — whichever comes
   * first wins and cancels the other.
   */
  const toggleDetails = () => {
    const el = drawerBodyRef.current;

    if (!detailsOpen) {
      if (el) preOpenScrollTop.current = el.scrollTop;
      setDetailsOpen(true);
      return;
    }

    if (!el) {
      setDetailsOpen(false);
      return;
    }

    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      el.removeEventListener('scrollend', finish);
      window.clearTimeout(fallback);
      setDetailsOpen(false);
    };
    el.addEventListener('scrollend', finish);
    const fallback = window.setTimeout(finish, 400);
    el.scrollTo({ top: preOpenScrollTop.current, behavior: 'smooth' });
  };

  // Escape closes, like every other overlay in the app — innermost first, so a
  // reader dismissing a receipt doesn't lose the run behind it. Handled here
  // rather than in the receipt panel because two listeners on the same key
  // would both fire and close both.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (openReceiptId !== null) setOpenReceiptId(null);
      else requestClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openReceiptId]);

  const totals = useMemo(() => totalReceipts(receipts ?? []), [receipts]);
  const stock = useMemo(() => totalStock(entries ?? []), [entries]);
  // Kept out of the receipt totals on purpose — see totalExpenses in lib/runs.ts.
  // Nothing in this panel subtracts `spend` from the sales, the returns or the net.
  const spend = useMemo(() => totalExpenses(expenses ?? []), [expenses]);
  const liveExpenses = useMemo(() => (expenses ?? []).filter((expense) => !expense.deleted), [expenses]);

  /**
   * Bread type names, catalog first and the run's own receipts second — see
   * `buildNameFor`. Ledger entries carry only a `breadTypeId`; receipts carry
   * a name snapshot taken when the line was added, so a bread type the
   * dashboard has since deleted still shows the name it sold under.
   */
  const nameFor = useMemo(() => buildNameFor(breadTypes, receipts ?? []), [breadTypes, receipts]);

  /**
   * Where a bread type sits in the catalog — the manual position a manager
   * dragged it to on Reference lists, which `breadTypes` already arrives
   * sorted by. The Inventory table lists bread in that order rather than
   * alphabetically, so a printed count sheet and this panel read down in the
   * same sequence. A bread type the catalog no longer holds has no position,
   * so it sorts after everything that does, alphabetically among itself.
   *
   * Inventory joins on `breadTypeId` and can use this directly; Outcome has to
   * fold returns in by name and does its own ordering — see `buildOutcomeRows`.
   */
  const catalogRank = useMemo(() => {
    const byId = new Map<string, number>();
    const byName = new Map<string, number>();
    breadTypes.forEach((type, index) => {
      byId.set(type.id, index);
      if (!byName.has(type.name)) byName.set(type.name, index);
    });
    return { byId, byName };
  }, [breadTypes]);

  const rankOfId = useMemo(
    () => (id: string) => catalogRank.byId.get(id) ?? catalogRank.byName.get(nameFor(id)) ?? Infinity,
    [catalogRank, nameFor],
  );

  /**
   * The Inventory tab's breakdown — initial count, one column per batch added
   * during the run, and a total — the same shape as the mobile app's own Run
   * history detail screen (RunHistoryModal's InventoryTable). `entries` arrives
   * oldest-first (see watchRunStockEntries), so the batch columns read left to
   * right in the order they were added.
   */
  const initialQuantities = useMemo(() => {
    const quantities = new Map<string, number>();
    for (const entry of entries ?? []) {
      if (entry.kind !== 'initial') continue;
      for (const item of entry.items) {
        quantities.set(item.breadTypeId, (quantities.get(item.breadTypeId) ?? 0) + item.quantity);
      }
    }
    return quantities;
  }, [entries]);

  const additionBatches = useMemo(
    () => (entries ?? []).filter((entry) => entry.kind === 'addition'),
    [entries],
  );

  /** When the initial count was written — the earliest 'initial' entry, since
   * `entries` arrives oldest-first. Null when there is none, or when the
   * document carried no usable timestamp. */
  const initialLoadedAt = useMemo(() => {
    const initial = (entries ?? []).find((entry) => entry.kind === 'initial' && entry.createdAt > 0);
    return initial ? initial.createdAt : null;
  }, [entries]);

  // `loaded` already sums initial + every addition (see totalStock) — the same
  // total the mobile table shows, just derived once instead of twice.
  const totalQuantities = useMemo(() => {
    const quantities = new Map<string, number>();
    for (const line of stock) quantities.set(line.breadTypeId, line.loaded);
    return quantities;
  }, [stock]);

  const inventoryBreadTypeIds = useMemo(() => {
    const ids = new Set<string>();
    initialQuantities.forEach((_, id) => ids.add(id));
    for (const batch of additionBatches) {
      for (const item of batch.items) ids.add(item.breadTypeId);
    }
    totalQuantities.forEach((_, id) => ids.add(id));
    return [...ids].sort((a, b) => rankOfId(a) - rankOfId(b) || nameFor(a).localeCompare(nameFor(b)));
  }, [initialQuantities, additionBatches, totalQuantities, nameFor, rankOfId]);

  /**
   * The Outcome tab — sold, returned and what that leaves aboard, per bread
   * type. Sold and remaining come from the ledger (`stock`, keyed by
   * `breadTypeId`); returns come from the receipts, and are a write-off with
   * no link back to a `breadTypeId` (see CLAUDE.md, "Returns are a write-off
   * only"), so the join happens on the **name** instead.
   *
   * Both catalogs go in because both can name a row: Bread Types is the main
   * reference, and Returned Bread Types places the returns it doesn't cover.
   * See `buildOutcomeRows` — the Excel export's Bread sheet is built by the
   * same function, off the same rows, so the two can't disagree.
   */
  const outcomeRows = useMemo(
    () =>
      buildOutcomeRows({
        stock,
        receipts: receipts ?? [],
        nameFor,
        breadTypes,
        returnedBreadTypes,
      }),
    [stock, receipts, nameFor, breadTypes, returnedBreadTypes],
  );

  /**
   * The Collected tab — money actually taken in, bucketed by payment method
   * the way a trucker thinks about it. Same rows, same order, same figures as
   * the mobile app's own Run history detail screen (MoneySection): Cash,
   * GCash, Cheque paid in full at finalize, a Partial receipt's full amount
   * owed *and* what was actually paid down on it, and Credit. Summed
   * straight off this run's receipts rather than the ledger — mirrors the
   * SQL in receipt-db.ts's summarizeRunHistoryForRun exactly, just in JS.
   */
  const collected = useMemo(() => {
    const totals = { cash: 0, gcash: 0, cheque: 0, partial: 0, partialPaid: 0, credit: 0 };
    for (const receipt of receipts ?? []) {
      // Voided receipts collected nothing — the same rule totalCollected keeps.
      if (receipt.voidedAt !== null) continue;
      switch (receipt.paymentMethod) {
        case 'cash':
          totals.cash += receipt.total;
          break;
        case 'gcash':
          totals.gcash += receipt.total;
          break;
        case 'cheque':
          totals.cheque += receipt.total;
          break;
        case 'partial':
          totals.partial += receipt.total;
          totals.partialPaid += receipt.amountPaid ?? 0;
          break;
        case 'credit':
          totals.credit += receipt.total;
          break;
        default:
          break;
      }
    }
    return totals;
  }, [receipts]);

  const loading = receipts === null || entries === null || expenses === null;

  const handleExport = async () => {
    if (loading || exporting) return;
    setExporting(true);
    setExportError(null);
    try {
      const { exportRunToExcel } = await import('@/lib/export-run-excel');
      await exportRunToExcel({
        run,
        tripNumber,
        receipts: receipts ?? [],
        entries: entries ?? [],
        expenses: expenses ?? [],
        breadTypes,
        returnedBreadTypes,
      });
    } catch (error) {
      console.error('[run-panel.export]', error);
      setExportError('Could not create the Excel file. Check your connection and try again.');
    } finally {
      setExporting(false);
    }
  };
  const visibleReceipts = showAllReceipts ? (receipts ?? []) : (receipts ?? []).slice(0, FeedPreviewCount);
  // Looked up fresh on every render, and null once the row is gone — a receipt
  // can disappear from the listener between opening it and reading it.
  const openReceipt = (receipts ?? []).find((r) => r.id === openReceiptId) ?? null;

  /**
   * Who was out when a receipt was written, for the feed rows and the detail
   * card alike.
   *
   * The receipt's own recorded name first — it is what the phone printed on the
   * customer's copy, so it is what should be read back to them from the server.
   * Every receipt in this panel belongs to *this* run, so the run header's own
   * snapshot is the complete fallback for one written before the phone recorded
   * names: no reference-list lookup is needed here, unlike in the store history
   * (see `agentsLabel` in stores-tab.tsx), which spans every run ever recorded.
   */
  const agentsFor = (receipt: RunReceipt) =>
    receipt.agentNames || (run.agents.length > 0 ? runAgentNames(run) : null);

  return (
    <>
      <div
        className={visible ? 'ops-scrim ops-panel-scrim open' : 'ops-scrim ops-panel-scrim'}
        onClick={requestClose}
      />
      <aside
        ref={drawerRef}
        className={visible ? 'ops-drawer ops-panel-drawer open' : 'ops-drawer ops-panel-drawer'}
        role="dialog"
        aria-label={`${run.truckName} — ${runAgentNames(run)}`}>
        <div className="ops-drawer-head">
          <div>
            <span className="ops-label">{runAgentNames(run)}</span>
            <h2>
              {run.truckName || 'Unnamed truck'}
              {run.sequence > 1 && <span className="ops-trip">Trip {run.sequence}</span>}
              <StatusPill run={run} />
            </h2>
          </div>
          <button type="button" className="ops-drawer-close" onClick={requestClose} aria-label="Close">
            ✕
          </button>
        </div>

        <div className="ops-drawer-body" ref={drawerBodyRef}>
          <div className="ops-drawer-main">
            <section className="ops-section">
              {/* The day's headline figures and the button that takes them
                  away as a spreadsheet, on one line: the export is *of* what
                  is directly below it, and at the bottom of the drawer it sat
                  under everything it doesn't cover. */}
              <div className="ops-section-head">
                <span className="ops-label ops-section-title">
                  {run.status === 'open' ? 'So far today' : 'Recorded'}
                </span>
                <button
                  type="button"
                  className="ops-export-btn"
                  disabled={loading || exporting}
                  onClick={handleExport}>
                  {exporting ? 'Exporting…' : 'Export'}
                </button>
              </div>
              {exportError && (
                <div className="ops-notice ops-notice-alert" role="alert">
                  {exportError}
                </div>
              )}
              <div className="ops-stats ops-stats-compact">
                <div className="ops-stat">
                  <span className="ops-label">Sales</span>
                  <div className="ops-figure">{formatMoney(totals.salesTotal)}</div>
                </div>
                <div className="ops-stat">
                  <span className="ops-label">Returns</span>
                  <div className="ops-figure">{formatMoney(totals.returnsTotal)}</div>
                </div>
                <div className="ops-stat ops-stat-accent">
                  <span className="ops-label">Net</span>
                  <div className="ops-figure">{formatMoney(totals.netTotal)}</div>
                </div>
                <div className="ops-stat">
                  <span className="ops-label">Receipts</span>
                  <div className="ops-figure">{formatCount(totals.receiptCount)}</div>
                  <p className="ops-stat-note">
                    {totals.storeCount === 1 ? '1 store' : `${formatCount(totals.storeCount)} stores`}
                    {/* Said beside the count it was left out of, so a feed with
                        more rows than this figure doesn't read as a mistake. */}
                    {totals.voidedCount > 0 && ` · ${formatCount(totals.voidedCount)} voided`}
                  </p>
                </div>
              </div>
            </section>

            <section className="ops-section">
            {/* Receipts first — it's the table read most, and the one someone
                is usually here for. Inventory, Outcome, Collected and
                Expenses are one tap away rather than always-visible sections,
                so a long receipt feed no longer pushes all four (and Run
                details, Reference) far down the drawer to scroll past. */}
            <div className="ops-subtabs" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={activityTab === 'receipts'}
                className={activityTab === 'receipts' ? 'ops-subtab active' : 'ops-subtab'}
                onClick={() => setActivityTab('receipts')}>
                Receipts
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activityTab === 'inventory'}
                className={activityTab === 'inventory' ? 'ops-subtab active' : 'ops-subtab'}
                onClick={() => setActivityTab('inventory')}>
                Inventory
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activityTab === 'outcome'}
                className={activityTab === 'outcome' ? 'ops-subtab active' : 'ops-subtab'}
                onClick={() => setActivityTab('outcome')}>
                Outcome
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activityTab === 'collected'}
                className={activityTab === 'collected' ? 'ops-subtab active' : 'ops-subtab'}
                onClick={() => setActivityTab('collected')}>
                Collected
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activityTab === 'expenses'}
                className={activityTab === 'expenses' ? 'ops-subtab active' : 'ops-subtab'}
                onClick={() => setActivityTab('expenses')}>
                Expenses
              </button>
            </div>

            {/* All five panels stay mounted, stacked in one grid cell (see
                .ops-tabpanels): the inactive ones are only hidden, not
                unmounted, so the grid row sizes to the tallest of the five.
                Without this, switching to a shorter tab shrinks the section
                and everything below it — Run details, the drawer's bottom
                edge — jumps up underneath the cursor. */}
            <div className="ops-tabpanels">
              <div className={activityTab === 'receipts' ? 'ops-tabpanel active' : 'ops-tabpanel'} role="tabpanel">
                {loading ? (
                  <p className="ops-muted">Loading…</p>
                ) : visibleReceipts.length === 0 ? (
                  <p className="ops-muted">No receipts have arrived from this run yet.</p>
                ) : (
                  <>
                    <div className="ops-feed">
                      {/* A button, not a div with a click handler: this opens
                          something, so it has to be reachable and operable from the
                          keyboard like every other control on the page. */}
                      {visibleReceipts.map((receipt) => {
                        const agents = agentsFor(receipt);
                        return (
                          <button
                            key={receipt.id}
                            type="button"
                            className={[
                              'ops-feed-row',
                              receipt.id === openReceiptId && 'ops-feed-row-open',
                              receipt.voidedAt !== null && 'ops-feed-row-void',
                            ]
                              .filter(Boolean)
                              .join(' ')}
                            aria-expanded={receipt.id === openReceiptId}
                            onClick={() => setOpenReceiptId(receipt.id)}>
                            {/* Spans rather than divs: a <button> may only contain
                                phrasing content, and these are inside one now. */}
                            <span>
                              <span className="ops-feed-store">{receipt.customerName || 'Unnamed store'}</span>
                              {/* Time then agents, the same sub-line shape the
                                  store history uses. */}
                              <span className="ops-sub">
                                {formatBusinessTime(receipt.createdAt)}
                                {agents && ` · ${agents}`}
                              </span>
                            </span>
                            {/* Amount over tag, the same right-hand column the
                                phone's list uses — the method left the run-on
                                detail line ("9:14 AM · Cash") to become a tag
                                here, so it's read at a glance instead of parsed
                                out of a sentence. */}
                            <span className="ops-feed-right">
                              <span
                                className={
                                  receipt.total < 0 ? 'ops-feed-amount ops-feed-amount-credit' : 'ops-feed-amount'
                                }>
                                {formatMoney(receipt.total)}
                              </span>
                              <ReceiptTag method={receipt.paymentMethod} voided={receipt.voidedAt !== null} />
                            </span>
                          </button>
                        );
                      })}
                    </div>
                    {!showAllReceipts && (receipts?.length ?? 0) > FeedPreviewCount && (
                      <button type="button" className="ops-more" onClick={() => setShowAllReceipts(true)}>
                        Show all {formatCount(receipts?.length ?? 0)} receipts
                      </button>
                    )}
                  </>
                )}
              </div>

              <div className={activityTab === 'inventory' ? 'ops-tabpanel active' : 'ops-tabpanel'} role="tabpanel">
                {loading ? (
                  <p className="ops-muted">Loading…</p>
                ) : inventoryBreadTypeIds.length === 0 ? (
                  <p className="ops-muted">No inventory has been counted onto this truck yet.</p>
                ) : (
                  <div className="ops-table-scroll">
                    <table className="ops-table">
                      <thead>
                        {/* The heading row is the switch: a click anywhere along
                            it shows when each load went on, another hides it.
                            The handler sits on the <tr> so the whole row works;
                            "Bread" is a real button so the keyboard can reach it,
                            and its click bubbles up to the same handler. */}
                        <tr
                          className="ops-load-times-row ops-load-times-align"
                          title={showLoadTimes ? 'Hide dates & times' : 'Show dates & times'}
                          onClick={() => setShowLoadTimes((shown) => !shown)}>
                          <th>
                            <button type="button" className="ops-load-times-button" aria-expanded={showLoadTimes}>
                              Bread
                            </button>
                          </th>
                          <th className="ops-num">
                            Initial
                            {showLoadTimes && <LoadedAt timestamp={initialLoadedAt} />}
                          </th>
                          {additionBatches.map((batch, index) => (
                            <th key={batch.id} className="ops-num">
                              Batch {index + 1}
                              {showLoadTimes && <LoadedAt timestamp={batch.createdAt > 0 ? batch.createdAt : null} />}
                            </th>
                          ))}
                          <th className="ops-num">Total</th>
                        </tr>
                      </thead>
                      <tbody>
                        {inventoryBreadTypeIds.map((id) => (
                          <tr key={id}>
                            <td>{nameFor(id)}</td>
                            <td className="ops-num">{formatCount(initialQuantities.get(id) ?? 0)}</td>
                            {additionBatches.map((batch) => {
                              const item = batch.items.find((entryItem) => entryItem.breadTypeId === id);
                              return (
                                <td key={batch.id} className="ops-num">
                                  {formatCount(item?.quantity ?? 0)}
                                </td>
                              );
                            })}
                            <td className="ops-num">
                              <b>{formatCount(totalQuantities.get(id) ?? 0)}</b>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              <div className={activityTab === 'outcome' ? 'ops-tabpanel active' : 'ops-tabpanel'} role="tabpanel">
                {loading ? (
                  <p className="ops-muted">Loading…</p>
                ) : outcomeRows.length === 0 ? (
                  <p className="ops-muted">Nothing sold or returned on this run yet.</p>
                ) : (
                  <div className="ops-table-scroll">
                    <table className="ops-table">
                      <thead>
                        {/* While the Inventory tab is showing load times its
                            heading row is two lines taller. An invisible copy of
                            those two lines here keeps this table's rows at the
                            same height, so flipping between the two tabs moves
                            nothing. */}
                        <tr className="ops-load-times-align">
                          <th>
                            Bread
                            {showLoadTimes && (
                              <span className="ops-loaded-at ops-loaded-at-spacer" aria-hidden="true">
                                &nbsp;
                                <br />
                                &nbsp;
                              </span>
                            )}
                          </th>
                          <th className="ops-num">Sold</th>
                          <th className="ops-num">Returned</th>
                          <th className="ops-num">Remaining</th>
                        </tr>
                      </thead>
                      <tbody>
                        {outcomeRows.map((row) => (
                          <tr key={row.name}>
                            <td>{row.name}</td>
                            <td className="ops-num">{formatCount(row.sold)}</td>
                            <td className="ops-num">{formatCount(row.returned)}</td>
                            <td className="ops-num">
                              <b>{formatCount(row.remaining)}</b>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              <div className={activityTab === 'collected' ? 'ops-tabpanel active' : 'ops-tabpanel'} role="tabpanel">
                {loading ? (
                  <p className="ops-muted">Loading…</p>
                ) : (
                  // Every row always shows, ₱0.00 and all — the same as the
                  // mobile screen this mirrors. There's no "nothing collected
                  // yet" state to branch to; a quiet run reads as zeroes, not
                  // as an empty table.
                  <table className="ops-table">
                    <thead>
                      <tr>
                        <th>Method</th>
                        <th className="ops-num">Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <td>Cash</td>
                        <td className="ops-num">{formatMoney(collected.cash)}</td>
                      </tr>
                      <tr>
                        <td>GCash</td>
                        <td className="ops-num">{formatMoney(collected.gcash)}</td>
                      </tr>
                      <tr>
                        <td>Cheque</td>
                        <td className="ops-num">{formatMoney(collected.cheque)}</td>
                      </tr>
                      <tr>
                        <td>Partial total</td>
                        <td className="ops-num">{formatMoney(collected.partial)}</td>
                      </tr>
                      <tr>
                        <td>Partial paid</td>
                        <td className="ops-num">{formatMoney(collected.partialPaid)}</td>
                      </tr>
                      <tr>
                        <td>Credit</td>
                        <td className="ops-num">{formatMoney(collected.credit)}</td>
                      </tr>
                    </tbody>
                  </table>
                )}
              </div>

              <div className={activityTab === 'expenses' ? 'ops-tabpanel active' : 'ops-tabpanel'} role="tabpanel">
                {loading ? (
                  <p className="ops-muted">Loading…</p>
                ) : liveExpenses.length === 0 ? (
                  <p className="ops-muted">No expenses were recorded on this run.</p>
                ) : (
                  <table className="ops-table">
                    <thead>
                      <tr>
                        <th>What for</th>
                        <th>Time</th>
                        <th className="ops-num">Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {liveExpenses.map((expense) => (
                        <tr key={expense.id}>
                          <td>
                            {expense.title || 'Untitled'}
                            {/* The notes field is optional and usually empty, so it
                                gets a line under the title rather than a column
                                that would be blank on most rows. */}
                            {expense.notes && <div className="ops-sub">{expense.notes}</div>}
                          </td>
                          <td>{formatBusinessTime(expense.createdAt)}</td>
                          <td className="ops-num">{formatMoney(expense.amount)}</td>
                        </tr>
                      ))}
                      <tr>
                        <td colSpan={2}>
                          <b>Total spent</b>
                        </td>
                        <td className="ops-num">
                          <b>{formatMoney(spend.total)}</b>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                )}
                {/* Said on the page, not just in the code. Somebody reading a run
                    will otherwise assume the net above has this taken out of it —
                    it does not, anywhere on this dashboard. */}
                <p className="ops-stat-note">
                  Recorded by the agents as a note about the trip. Expenses are not deducted from the sales, the net, or
                  anything on the Trends tab.
                </p>
              </div>
            </div>
            </section>
          </div>

          {/* Separated by the hairline from .ops-section-break — this is the
              one part of the panel nobody is here for most of the time, so
              it's collapsed by default and opened on demand rather than
              always taking up the space. */}
          <section className="ops-section ops-section-break">
            <button
              type="button"
              className="ops-collapse-toggle"
              aria-expanded={detailsOpen}
              onClick={toggleDetails}>
              <span className="ops-label">Run details</span>
              <span className={detailsOpen ? 'ops-collapse-caret open' : 'ops-collapse-caret'} aria-hidden="true">
                ▸
              </span>
            </button>

            {detailsOpen && (
              <>
                <div className="ops-meta">
                  <div>
                    <span>Agents</span>
                    <b>{runAgentNames(run)}</b>
                  </div>
                  <div>
                    <span>Started</span>
                    <b>{run.startedAt ? formatBusinessTime(run.startedAt) : '—'}</b>
                  </div>
                  {/* The end carries its date whenever the run outlived the day
                      it started — see describeRunEnd. The panel is opened from a
                      row filed under the start day, so without it "6:42 PM"
                      silently claims the run finished that evening. */}
                  <div>
                    <span>{run.status === 'open' ? 'Out for' : 'Ended'}</span>
                    <b>
                      {run.status === 'open'
                        ? formatDuration(now - run.startedAt)
                        : run.closedAt
                          ? `${describeRunEnd(run)} · ${formatDuration(run.closedAt - run.startedAt)}`
                          : '—'}
                    </b>
                  </div>
                  {/* Only for a run that spanned days. On the ordinary run this
                      is the start date restated, which is worse than nothing on
                      a panel that already has a lot to say. */}
                  {runSpansDays(run) && (
                    <div>
                      <span>Business days</span>
                      <b>
                        {countBusinessDays(run.businessDay, runEndDay(run))} days · filed under{' '}
                        {formatBusinessDayShort(run.businessDay)}
                      </b>
                    </div>
                  )}
                  <div>
                    <span>Signed in as</span>
                    <b>{run.createdByEmail || '—'}</b>
                  </div>
                </div>

                {/* The run id rides along under the same toggle — it's the
                    other thing here only for the rare lookup, quoted when
                    something has to be found in Firestore by hand. */}
                <div className="ops-meta ops-meta-reference">
                  <div>
                    <span>Run id</span>
                    <b className="ops-id">{run.id}</b>
                  </div>
                </div>
              </>
            )}
          </section>
        </div>
      </aside>

      {/* Shown over the whole drawer while the workbook is being built. The
          export pulls every proof-of-payment photo down over the network
          before it can hand back a file, which is a few seconds on a run with
          a lot of receipts — a button that just reads "Exporting…" in the
          corner is easy to miss, and clicking elsewhere in the meantime is
          confusing. This blocks the drawer until the file is ready or fails. */}
      {exporting && (
        <div className="ops-export-scrim" role="alertdialog" aria-live="assertive" aria-label="Preparing export">
          <div className="ops-export-modal">
            <div className="ops-spinner" aria-hidden="true" />
            <p>
              Preparing your Excel file…
              <span className="ops-sub">This can take a few seconds while the photos are gathered.</span>
            </p>
          </div>
        </div>
      )}

      {/* A sibling of the drawer, not a child of it: the drawer scrolls, and a
          card inside a scrolling column would scroll away with it. */}
      <ReceiptDetailPanel
        receipt={openReceipt}
        agentsLabel={agentsFor}
        onClose={() => setOpenReceiptId(null)}
      />
    </>
  );
}

/**
 * The date and time one load went onto the truck, under its column heading.
 *
 * Both halves are Manila's — the day through `businessDayKey`, never the
 * browser's own calendar — so a 5:40 AM load reads 5:40 AM wherever the page
 * is open. The date is always shown, not only when it differs from the run's
 * day: a run can span days, and a top-up on the second morning has to say so.
 */
function LoadedAt({ timestamp }: { timestamp: number | null }) {
  // Two lines even when there is nothing to say, so an unknown time can't make
  // the heading row shorter than the Outcome table's spacer expects.
  if (timestamp === null) {
    return (
      <span className="ops-loaded-at">
        —
        <br />
        &nbsp;
      </span>
    );
  }
  return (
    <span className="ops-loaded-at">
      {formatBusinessDayShort(businessDayKey(timestamp))}
      <br />
      {formatBusinessTime(timestamp)}
    </span>
  );
}

function StatusPill({ run }: { run: Run }) {
  if (run.status === 'open') {
    return (
      <span className="ops-pill ops-pill-live">
        <span className="ops-dot" />
        Out now
      </span>
    );
  }
  return <span className="ops-pill ops-pill-closed">Day ended</span>;
}
