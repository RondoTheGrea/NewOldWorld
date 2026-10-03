import { memo, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';

import { ChartCard, ChartEmpty, ColumnChart, compactMoney, type Column } from '@/components/charts';
import { ReceiptTag } from '@/components/payment-tag';
import { ReceiptDetailPanel } from '@/components/receipt-detail-panel';
import { watchAgentGroups, watchAgents, type Agent, type AgentGroup } from '@/lib/agent-groups';
import { formatBusinessTime } from '@/lib/business-day';
import { formatDeliveryDays, watchCustomers, type Customer } from '@/lib/customers';
import { watchNamedRecords, type NamedRecord } from '@/lib/named-records';
import { fetchReceiptsForCustomer, formatCount, formatMoney, type RunReceipt } from '@/lib/runs';

/**
 * The Stores tab: the route, as a directory.
 *
 * Stores are the one collection on this dashboard that is **not** dashboard-
 * owned — every phone writes them and every phone pulls them back down (see
 * "Sync" in CLAUDE.md). So this page reads and never writes: editing a store
 * here would put the dashboard into a last-write-wins merge designed around
 * phones that are offline for hours, and the phone that has the store in front
 * of it is the better authority anyway.
 *
 * What it is for is the thing a phone can't do: seeing every store at once,
 * finding the one you want, and reading its whole history across every truck
 * and every day.
 */

const ALL = '__all__';

/**
 * How many stores the directory draws before offering "Show 25 more". It can
 * run to thousands, and a table of thousands of rows is slow to draw and
 * nobody reads to the bottom of it. The count in the filter bar always says
 * how many there really are.
 */
const StorePageSize = 25;

export function StoresTab() {
  const [customers, setCustomers] = useState<Customer[] | null>(null);
  const [areas, setAreas] = useState<NamedRecord[]>([]);
  const [agentGroups, setAgentGroups] = useState<AgentGroup[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState('');
  const [areaFilter, setAreaFilter] = useState<string>(ALL);
  const [crewFilter, setCrewFilter] = useState<string>(ALL);
  const [selected, setSelected] = useState<Customer | null>(null);
  // How many rows of the unfiltered directory are drawn — see StorePageSize.
  const [shownStores, setShownStores] = useState(StorePageSize);

  useEffect(
    () =>
      watchCustomers(setCustomers, () =>
        setError('Could not load stores. Check your connection — this list reloads on its own once it is back.'),
      ),
    [],
  );
  useEffect(() => watchNamedRecords('areas', setAreas), []);
  // A store stamps `agentGroupId`, not a name — resolved against the crew list
  // as it reads now, the same bargain the receipt feed's crew label makes.
  useEffect(() => watchAgentGroups(setAgentGroups), []);

  const areaNames = useMemo(() => new Map(areas.map((area) => [area.id, area.name])), [areas]);
  const crewNames = useMemo(() => new Map(agentGroups.map((group) => [group.id, group.name])), [agentGroups]);

  // The list is drawn from *deferred* copies of the search and the filters.
  // The box and the dropdowns update the instant they are touched; the table
  // catches up behind them in a render React can interrupt, and `drawing` is
  // true in between — which is what the grey overlay shows. Without this, a
  // filter matching hundreds of stores froze the page, typing included.
  const deferredSearch = useDeferredValue(search);
  const deferredArea = useDeferredValue(areaFilter);
  const deferredCrew = useDeferredValue(crewFilter);
  const drawing = search !== deferredSearch || areaFilter !== deferredArea || crewFilter !== deferredCrew;

  const filtered = useMemo(() => {
    const needle = deferredSearch.trim().toLowerCase();
    return (customers ?? []).filter((customer) => {
      if (deferredArea !== ALL && (customer.areaId ?? '') !== deferredArea) return false;
      if (deferredCrew !== ALL && (customer.agentGroupId ?? '') !== deferredCrew) return false;
      if (!needle) return true;
      // Searched across everything printed on the row plus the address, so a
      // half-remembered street name finds the shop.
      return [customer.storeName, customer.name, customer.address, customer.phone]
        .join(' ')
        .toLowerCase()
        .includes(needle);
    });
  }, [customers, deferredSearch, deferredArea, deferredCrew]);

  // A search or a filter shows every match — the reader asked a question, and
  // an answer cut at 25 would hide the store they were looking for. Only the
  // whole directory is paged, and changing the question starts it back at 25.
  const narrowed = deferredSearch.trim() !== '' || deferredArea !== ALL || deferredCrew !== ALL;
  useEffect(() => setShownStores(StorePageSize), [deferredSearch, deferredArea, deferredCrew]);
  const visible = narrowed ? filtered : filtered.slice(0, shownStores);

  return (
    <>
      <div className="ops-filterbar">
        <input
          type="search"
          className="ops-search"
          placeholder="Search stores, contacts, addresses…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />

        <select className="ops-select" value={areaFilter} onChange={(event) => setAreaFilter(event.target.value)}>
          <option value={ALL}>All areas</option>
          {areas.map((area) => (
            <option key={area.id} value={area.id}>
              {area.name}
            </option>
          ))}
          {/* A store whose area was deleted, or that never had one, still has to
              be findable — otherwise it can only be reached by scrolling. */}
          <option value="">No area</option>
        </select>

        <select className="ops-select" value={crewFilter} onChange={(event) => setCrewFilter(event.target.value)}>
          <option value={ALL}>All crews</option>
          {agentGroups.map((group) => (
            <option key={group.id} value={group.id}>
              {group.name}
            </option>
          ))}
          {/* Same reasoning as "No area" — a store with no crew, or one whose
              crew was deleted, has to be reachable without scrolling. */}
          <option value="">No crew</option>
        </select>

        <span className="ops-muted">
          {customers === null ? 'Loading…' : `${formatCount(filtered.length)} of ${formatCount(customers.length)} stores`}
        </span>
      </div>

      {error && (
        <div className="ops-day-notices">
          <div className="ops-notice ops-notice-alert">{error}</div>
        </div>
      )}

      <div className="ops-stores-body" aria-busy={drawing}>
        {drawing && (
          <div className="ops-busy ops-busy-delayed" role="status">
            <div className="ops-busy-label">
              <div className="ops-spinner" aria-hidden="true" />
              Finding stores…
            </div>
          </div>
        )}

        {customers === null ? (
          <p className="ops-muted">Loading stores…</p>
        ) : customers.length === 0 ? (
          <div className="ops-empty">
            <strong>No stores yet</strong>
            Stores are added by the agents on their phones. None have reached the server yet.
          </div>
        ) : filtered.length === 0 ? (
          <div className="ops-empty">
            <strong>Nothing matches</strong>
            No store matches that search and those filters.
          </div>
        ) : (
          <StoreTable
            stores={visible}
            selectedId={selected?.id ?? null}
            areaNames={areaNames}
            crewNames={crewNames}
            onSelect={setSelected}
          />
        )}

        {customers !== null && visible.length < filtered.length && (
          <p>
            <button type="button" className="ops-more" onClick={() => setShownStores((shown) => shown + StorePageSize)}>
              Show {formatCount(Math.min(StorePageSize, filtered.length - visible.length))} more
            </button>
            <span className="ops-muted">
              {' '}
              Showing {formatCount(visible.length)} of {formatCount(filtered.length)} stores
            </span>
          </p>
        )}
      </div>

      {selected && (
        <StorePanel
          customer={selected}
          areaName={selected.areaId ? (areaNames.get(selected.areaId) ?? 'Area deleted') : 'No area'}
          onClose={() => setSelected(null)}
        />
      )}
    </>
  );
}

/**
 * The directory's rows, memoised so a keystroke in the search box doesn't
 * redraw them. That is what lets the deferred search above work: the urgent
 * render (the box itself) skips this entirely, and only the deferred one —
 * which React can interrupt — draws the new rows.
 */
const StoreTable = memo(function StoreTable({
  stores,
  selectedId,
  areaNames,
  crewNames,
  onSelect,
}: {
  stores: Customer[];
  selectedId: string | null;
  areaNames: Map<string, string>;
  crewNames: Map<string, string>;
  onSelect: (customer: Customer) => void;
}) {
  return (
    <div className="ops-area">
      <div className="ops-runs-scroll">
        <table className="ops-runs">
          <thead>
            <tr>
              <th>Store</th>
              <th>Area</th>
              <th>Crew</th>
              <th>Delivery days</th>
              <th>Phone</th>
            </tr>
          </thead>
          <tbody>
            {stores.map((customer) => (
              <tr
                key={customer.id}
                className={customer.id === selectedId ? 'ops-run-selected' : undefined}
                tabIndex={0}
                onClick={() => onSelect(customer)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onSelect(customer);
                  }
                }}>
                <td>
                  <div className="ops-truck">{customer.storeName || 'Unnamed store'}</div>
                  <div className="ops-sub">{customer.name || 'No contact name'}</div>
                </td>
                <td>{customer.areaId ? (areaNames.get(customer.areaId) ?? 'Area deleted') : 'No area'}</td>
                <td>{customer.agentGroupId ? (crewNames.get(customer.agentGroupId) ?? 'Crew deleted') : 'No crew'}</td>
                <td>{formatDeliveryDays(customer.deliveryDays)}</td>
                <td>{customer.phone || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
});

// ---------------------------------------------------------------------------
// One store
// ---------------------------------------------------------------------------

/**
 * How many receipts the panel's list shows at first, and how many more each
 * "Show 10 more" adds. Every receipt is read — the totals and the chart cover
 * the store's whole history — only the list is walked into ten at a time.
 */
const ReceiptPageSize = 10;

/**
 * Who was out when this receipt was written, in the order the answers can be
 * trusted.
 *
 * **The receipt's own recorded name comes first**, because it is the one answer
 * that is a fact about *this receipt* rather than about the crew today: the
 * phone copied it onto the row at finalize and printed it on the customer's
 * copy. Someone reading the server's copy of a receipt back to the store over the telephone has to
 * be describing the same piece of paper, and a crew renamed since would
 * otherwise make this row contradict it.
 *
 * That reverses the original ordering here, which resolved `agentGroupId`
 * against the reference lists as they read *now* on the grounds that a manager
 * wants the crew they can go and ask. The lookup is still what answers for a
 * receipt finalized before the phone recorded a name — nothing was backfilled
 * (see the Receipts section of CLAUDE.md) — so no row loses a crew it used to
 * show; the newer ones simply stop drifting away from the paper.
 *
 * The `agentIds` fallback is why all three fields are worth reading. Deleting a
 * crew deletes its people too, so it usually can't help — but an agent moved out
 * of a crew that was later deleted still names somebody, and a name is worth
 * more than "Crew removed". Only with nothing at all to say does this return
 * null and the row omit the segment: a receipt written before crews existed
 * carries none of the three, and "No crew" would read as information.
 */
function crewLabel(receipt: RunReceipt, crewNames: Map<string, string>, agentNames: Map<string, string>) {
  if (receipt.agentGroupName) return receipt.agentGroupName;

  const name = receipt.agentGroupId ? crewNames.get(receipt.agentGroupId) : undefined;
  if (name) return name;

  const people = receipt.agentIds
    .map((id) => agentNames.get(id))
    .filter((agentName): agentName is string => !!agentName)
    .join(', ');
  if (people) return people;

  return receipt.agentGroupId ? 'Crew removed' : null;
}

function StorePanel({ customer, areaName, onClose }: { customer: Customer; areaName: string; onClose: () => void }) {
  /**
   * The same slide-in-from-the-right / fade-in-scrim the run panel uses (see
   * run-panel.tsx for the full rationale), on the shared .ops-panel-drawer /
   * .ops-panel-scrim classes so the two read as one motion rather than two
   * similar ones. `requestClose` — used by the ✕ and the scrim, in place of
   * calling `onClose` directly — plays the reverse transition and only calls
   * the real `onClose` (which unmounts this panel) once it finishes.
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

  const [receipts, setReceipts] = useState<RunReceipt[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [trucks, setTrucks] = useState<NamedRecord[]>([]);
  const [agentGroups, setAgentGroups] = useState<AgentGroup[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  /**
   * Which receipt is open on the left, held as an **id** rather than the row
   * itself — the same contract the run panel uses, so one card serves both.
   * Here the rows are fetched once rather than watched, but keeping the id means
   * a re-fetch can't leave a stale copy of a receipt pinned open.
   */
  const [openReceiptId, setOpenReceiptId] = useState<string | null>(null);
  // How many rows of the receipt list are showing. Only ever grows; a
  // different store starts again at ReceiptPageSize.
  const [shownReceipts, setShownReceipts] = useState(ReceiptPageSize);

  useEffect(() => watchNamedRecords('trucks', setTrucks), []);
  /* Both crew lists, for the same reason the trucks list is here: a receipt
     stamps ids, not names. Two listeners rather than one because an agent's
     crew is a field on the agent, so somebody can move between crews without
     either crew document being touched. They live and die with this panel, so
     a reader who never opens a store pays for neither. */
  useEffect(() => watchAgentGroups(setAgentGroups), []);
  useEffect(() => watchAgents(setAgents), []);

  useEffect(() => {
    let cancelled = false;
    setReceipts(null);
    setError(null);
    setOpenReceiptId(null);
    setShownReceipts(ReceiptPageSize);

    void fetchReceiptsForCustomer(customer.id).then(
      (rows) => {
        if (!cancelled) setReceipts(rows);
      },
      () => {
        if (!cancelled) setError('Could not load this store’s receipts.');
      },
    );

    return () => {
      cancelled = true;
    };
  }, [customer.id]);

  // Escape closes the innermost overlay first, so a reader dismissing a receipt
  // keeps the store behind it. Owned here rather than in the receipt panel
  // because two listeners on the same key would both fire and close both.
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

  const truckNames = useMemo(() => new Map(trucks.map((truck) => [truck.id, truck.name])), [trucks]);
  const crewNames = useMemo(() => new Map(agentGroups.map((group) => [group.id, group.name])), [agentGroups]);
  const agentNames = useMemo(() => new Map(agents.map((agent) => [agent.id, agent.name])), [agents]);

  // Voided receipts stay in the list below and count in none of these, the
  // same rule as every other total on the dashboard (see RunReceipt.voidedAt).
  const totals = useMemo(() => {
    const rows = (receipts ?? []).filter((receipt) => receipt.voidedAt === null);
    return {
      count: rows.length,
      net: rows.reduce((sum, receipt) => sum + receipt.total, 0),
      returns: rows.reduce((sum, receipt) => sum + receipt.returnsTotal, 0),
      // Newest standing receipt — `receipts` arrives newest first. A voided
      // one billed nobody, so it isn't a visit either; reading `receipts[0]`
      // let a receipt cancelled this morning stand in for the last real sale.
      lastVisit: rows[0]?.businessDay ?? null,
    };
  }, [receipts]);

  /**
   * Spend per visit, oldest first.
   *
   * Grouped by the receipt's **stored** `businessDay`, never re-derived from
   * `createdAt` — a browser in another timezone would file a 6:30 AM Manila
   * delivery under the previous day, which for a store visited weekly moves a
   * bar to the wrong week.
   */
  const columns: Column[] = useMemo(() => {
    const byDay = new Map<string, { net: number; receipts: number }>();
    for (const receipt of receipts ?? []) {
      if (receipt.voidedAt !== null) continue;
      const row = byDay.get(receipt.businessDay) ?? { net: 0, receipts: 0 };
      row.net += receipt.total;
      row.receipts += 1;
      byDay.set(receipt.businessDay, row);
    }
    return [...byDay.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([day, row]) => ({
        key: day,
        label: day.slice(5).replace('-', '/'),
        value: row.net,
        detail: row.receipts > 1 ? `${row.receipts} receipts` : undefined,
      }));
  }, [receipts]);

  // Looked up fresh on every render, and null once the row is gone — the same
  // rule the run panel follows.
  const openReceipt = (receipts ?? []).find((receipt) => receipt.id === openReceiptId) ?? null;

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
        aria-label={customer.storeName}
        aria-busy={receipts === null && !error}>
        {/* Greys the panel until every receipt is in — the tiles, the chart
            and the list are all built from them, and a half-read store looks
            like a real one. A failed read lifts it so the error shows. */}
        {receipts === null && !error && (
          <div className="ops-drawer-loading" role="status">
            <div className="ops-spinner" aria-hidden="true" />
            Loading this store’s receipts…
          </div>
        )}
        <div className="ops-drawer-head">
          <div>
            <span className="ops-label">{areaName}</span>
            <h2>{customer.storeName || 'Unnamed store'}</h2>
          </div>
          <button type="button" className="ops-drawer-close" onClick={requestClose} aria-label="Close">
            ✕
          </button>
        </div>

        <div className="ops-drawer-body">
          <section className="ops-section">
            <div className="ops-meta">
              <div>
                <span>Contact</span>
                <b>{customer.name || '—'}</b>
              </div>
              <div>
                <span>Phone</span>
                <b>{customer.phone || '—'}</b>
              </div>
              <div>
                <span>Delivery days</span>
                <b>{formatDeliveryDays(customer.deliveryDays)}</b>
              </div>
              <div>
                <span>Crew</span>
                <b>
                  {customer.agentGroupId
                    ? (crewNames.get(customer.agentGroupId) ?? 'Crew deleted')
                    : 'No crew'}
                </b>
              </div>
              <div>
                <span>Address</span>
                <b>{customer.address || '—'}</b>
              </div>
            </div>
          </section>

          {customer.description && (
            <section className="ops-section">
              <span className="ops-label">Description</span>
              <p className="ops-stat-note">{customer.description}</p>
            </section>
          )}

          <section className="ops-section">
            <span className="ops-label">All time</span>
            <div className="ops-stats ops-stats-compact">
              <div className="ops-stat ops-stat-accent">
                <span className="ops-label">Net billed</span>
                <div className="ops-figure">{formatMoney(totals.net)}</div>
              </div>
              <div className="ops-stat">
                <span className="ops-label">Returns</span>
                <div className="ops-figure">{formatMoney(totals.returns)}</div>
              </div>
              <div className="ops-stat">
                <span className="ops-label">Receipts</span>
                <div className="ops-figure">{formatCount(totals.count)}</div>
              </div>
              <div className="ops-stat">
                <span className="ops-label">Last visit</span>
                <div className="ops-figure ops-figure-small">
                  {receipts === null ? '…' : (totals.lastVisit ?? 'Never')}
                </div>
              </div>
            </div>
          </section>

          {error && <div className="ops-notice ops-notice-alert">{error}</div>}

          {receipts !== null && (
            <ChartCard
              title="What this store buys"
              note="Net billed per visit — sales less any returns credited that day."
              table={
                <table className="ops-table">
                  <thead>
                    <tr>
                      <th>Day</th>
                      <th className="ops-num">Net</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...columns].reverse().map((column) => (
                      <tr key={column.key}>
                        <td>{column.key}</td>
                        <td className="ops-num">
                          <b>{formatMoney(column.value)}</b>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              }>
              {columns.length === 0 ? (
                <ChartEmpty>No receipts have been recorded for this store yet.</ChartEmpty>
              ) : (
                <ColumnChart columns={columns} height={160} formatFull={formatMoney} format={compactMoney} />
              )}
            </ChartCard>
          )}

          <section className="ops-section">
            <span className="ops-label">Receipts</span>
            {receipts === null ? (
              <p className="ops-muted">Loading…</p>
            ) : receipts.length === 0 ? (
              <p className="ops-muted">Nothing has been sold to this store yet.</p>
            ) : (
              <div className="ops-feed">
                {/* A button, not a div with a click handler — this opens
                    something, so it has to be reachable and operable from the
                    keyboard, exactly as the run panel's feed is. */}
                {receipts.slice(0, shownReceipts).map((receipt) => {
                  const crew = crewLabel(receipt, crewNames, agentNames);
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
                        <span className="ops-feed-store">{receipt.businessDay}</span>
                        {/* Truck then crew — what carried it and who was aboard,
                            the two halves of "which trip was this". */}
                        <span className="ops-sub">
                          {formatBusinessTime(receipt.createdAt)}
                          {receipt.truckId && ` · ${truckNames.get(receipt.truckId) ?? 'Truck removed'}`}
                          {crew && ` · ${crew}`}
                        </span>
                      </span>
                      {/* Same amount-over-tag column as the run panel's feed and
                          the phone's list. This list had no payment tag at all,
                          which made "how did they pay last time" a question that
                          needed a receipt opened for every row. */}
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
            )}
            {receipts !== null && receipts.length > shownReceipts && (
              <p>
                <button
                  type="button"
                  className="ops-more"
                  onClick={() => setShownReceipts((shown) => shown + ReceiptPageSize)}>
                  Show {formatCount(Math.min(ReceiptPageSize, receipts.length - shownReceipts))} more
                </button>
                <span className="ops-muted">
                  {' '}
                  Showing {formatCount(shownReceipts)} of {formatCount(receipts.length)} receipts
                </span>
              </p>
            )}
          </section>
        </div>
      </aside>

      {/* The same card the run panel opens, and it costs no read here either:
          fetchReceiptsForCustomer returns whole receipts, items and returns
          included. It carries the business day in its own header, which is why
          months of history reads correctly from this side. */}
      <ReceiptDetailPanel
        receipt={openReceipt}
        crewName={(receipt) => crewLabel(receipt, crewNames, agentNames)}
        onClose={() => setOpenReceiptId(null)}
      />
    </>
  );
}
