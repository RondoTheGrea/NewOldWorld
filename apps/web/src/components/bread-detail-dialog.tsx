import { useEffect, useRef, useState } from 'react';

import { ChartEmpty, SplitBarChart } from '@/components/charts';
import { formatBusinessDayShort } from '@/lib/business-day';
import type { BreadDetail, BreadSlice } from '@/lib/bread-detail';
import { formatCount, formatShare } from '@/lib/runs';

/**
 * How many shops the store list draws before it stops and offers the rest.
 *
 * The list is ordered by loaves, so the top of it is the answer to "who takes
 * this bread" and the tail is a long roll call — and for a popular bread over
 * a month or a year that tail is most of the customer directory. Twenty-five
 * rows is a screen and a bit: enough that the shape of the list is visible,
 * few enough that opening a dialog never costs a thousand table cells nobody
 * scrolled to. The rest is one click away and the button says how many.
 */
const StoreListCap = 25;

/**
 * One bread type, opened from the Trends tab's bread chart.
 *
 * **What it is for.** The chart answers "what moved" for every bread at once;
 * the next question a manager asks is always about one of them — which crew
 * shifts it, which round it sells on, which shops take it and which have
 * quietly stopped. Those are three cuts of the same loaves, so they are three
 * blocks of one dialog rather than three more cards on a tab that is already
 * long.
 *
 * **A dialog, not a drawer.** The page's own rule (see `.ops-dialog` in
 * `overview.css`): a drawer is a *place* you go into and read — a run, a store
 * — and a dialog is one question asked and answered. This is asked of one row
 * and is gone the moment it has been read, and it must not displace the chart
 * it was opened from, because the reader is comparing it against the row still
 * visible behind the scrim.
 *
 * **Counted in loaves, with no money anywhere in it**, exactly like the
 * section it opens from. The pesos are General statistics' subject; repeating
 * them here would make the one place that answers "what physically moved"
 * answer that second.
 *
 * **It draws only what was already read.** The dialog fires no query of its
 * own: every figure comes from the receipts the tab had already fetched, and
 * when some run's receipts failed to read the `failed` line says so here as
 * well as on the tab. A dialog that quietly showed a fuller or emptier picture
 * than the row behind it would be worse than one that admits the gap.
 */
export function BreadDetailDialog({
  name,
  sold,
  returned,
  stores,
  detail,
  series,
  rangeLabel,
  scope,
  failed,
  loading,
  onClose,
}: {
  name: string;
  /** Loaves sold in the period, in scope — the same figure the row shows. */
  sold: number;
  /** Loaves that came back. */
  returned: number;
  /**
   * How many different shops took it — passed in rather than counted from
   * `detail.stores`, because the row's own Stores column counts *identified*
   * stores on the sold side only and the two must print the same number.
   */
  stores: number;
  detail: BreadDetail;
  /** The bar's two segments, handed down so the dialog can't colour them differently from the chart. */
  series: { label: string; color: string }[];
  /** "1–31 August 2026" — which period these figures are. */
  rangeLabel: string;
  /** " for Crew A in Cainta", or empty when nothing is filtered. */
  scope: string;
  failed: boolean;
  loading: boolean;
  onClose: () => void;
}) {
  const card = useRef<HTMLDivElement>(null);
  // Reset by unmounting: the tab renders this only while a row is open, so
  // closing the dialog and opening another bread starts capped again.
  const [allStores, setAllStores] = useState(false);

  // Focus moves into the dialog on open so Escape reaches it and a tab lands
  // inside rather than back on the page behind the scrim.
  useEffect(() => {
    card.current?.focus();
  }, []);

  // The same rounding the row's own Rate column uses, and an em-dash on
  // nothing sold for the same reason it does.
  const rate = sold > 0 ? formatShare(returned / sold) : '—';
  const moved = sold > 0 || returned > 0;
  const shownStores = allStores ? detail.stores : detail.stores.slice(0, StoreListCap);
  const hiddenStores = detail.stores.length - shownStores.length;

  return (
    <>
      <div className="ops-scrim ops-dialog-scrim" onClick={onClose} />
      <div
        className="ops-dialog ops-dialog-wide"
        role="dialog"
        aria-modal="true"
        aria-labelledby="bread-detail-title"
        tabIndex={-1}
        ref={card}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return;
          event.stopPropagation();
          onClose();
        }}>
        <div className="ops-dialog-head">
          <div>
            <span className="ops-label">Bread type</span>
            <h2 id="bread-detail-title">{name}</h2>
          </div>
          <button type="button" className="ops-drawer-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        {/* What these figures are a slice of, in the same words the chart's own
            note uses — the dialog covers that note, so it has to carry it. */}
        <p className="ops-dialog-note">
          {rangeLabel}
          {scope || ', across every crew and area'}.{loading && ' Still reading receipts…'}
          {failed && ' Some runs could not be read, so the figures may be short.'}
        </p>

        <div className="ops-stats ops-stats-compact">
          <div className="ops-stat">
            <span className="ops-label">Sold</span>
            <div className="ops-figure ops-figure-small">{formatCount(sold)}</div>
            <p className="ops-stat-note">loaves</p>
          </div>
          <div className="ops-stat">
            <span className="ops-label">Came back</span>
            <div className="ops-figure ops-figure-small">{formatCount(returned)}</div>
            <p className="ops-stat-note">loaves</p>
          </div>
          <div className="ops-stat">
            <span className="ops-label">Return rate</span>
            <div className="ops-figure ops-figure-small">{rate}</div>
            <p className="ops-stat-note">of what sold</p>
          </div>
          <div className="ops-stat">
            <span className="ops-label">Stores</span>
            <div className="ops-figure ops-figure-small">{formatCount(stores)}</div>
            <p className="ops-stat-note">took it</p>
          </div>
        </div>

        {!moved ? (
          <ChartEmpty>
            {loading ? 'Reading receipts…' : `No ${name} moved in this period${scope}.`}
          </ChartEmpty>
        ) : (
          <>
            <SliceBlock title="By crew" lead="Crew" slices={detail.crews} series={series} />
            <SliceBlock title="By area" lead="Area" slices={detail.areas} series={series} />

            {/* The stores are a list, not a chart. A crew or an area is a
                handful of rows a bar can compare at a glance; the shops that
                take one bread run to dozens, and what is wanted of them is a
                roll call with a date on it — who takes the most, and who has
                stopped. */}
            <section className="ops-dialog-block">
              <h3 className="ops-dialog-block-title">Stores</h3>
              {detail.stores.length === 0 ? (
                <p className="ops-muted">No store took this bread in the period.</p>
              ) : (
                <table className="ops-table">
                  <thead>
                    <tr>
                      <th>Store</th>
                      <th className="ops-num">Sold</th>
                      <th className="ops-num">Came back</th>
                      <th className="ops-num">Last taken</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shownStores.map((store) => (
                      <tr key={store.key}>
                        <td>{store.name}</td>
                        <td className="ops-num">{formatCount(store.sold)}</td>
                        <td className="ops-num">{formatCount(store.returned)}</td>
                        {/* The stored businessDay string, formatted — never a
                            day worked out from a timestamp in the browser's
                            own zone. A store with returns and no sales has
                            never taken it, and gets a dash. */}
                        <td className="ops-num">
                          {store.lastDay ? formatBusinessDayShort(store.lastDay) : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {/* Says what the click gives you, not what the list totals.
                  A total here would be a second store count on a card that
                  already carries one, and the two can honestly differ: the
                  tile counts *identified* shops on the sold side, where the
                  list can also hold the no-store bucket and a shop that only
                  ever sent this bread back. One number, one meaning.

                  Only ever offered, never taken away again — a reader who
                  asked for the rest and then watched it fold up under them
                  would have to find their place twice. Closing the dialog is
                  the way back. */}
              {hiddenStores > 0 && (
                <button
                  type="button"
                  className="ops-chart-toggle ops-dialog-more"
                  onClick={() => setAllStores(true)}>
                  Show {formatCount(hiddenStores)} more
                </button>
              )}
            </section>
          </>
        )}
      </div>
    </>
  );
}

/**
 * One cut of the bread — the crews, or the areas — drawn as the same split bar
 * the chart behind the scrim uses.
 *
 * Deliberately the *same* component and the same two colours: a reader who has
 * just clicked a blue-and-orange row should find blue and orange meaning the
 * same two things one layer in. No `extras` columns here, though — a rate and
 * a store count are what the section's rows carry, and repeating them per crew
 * would be four figures on a row in a box half the width.
 */
function SliceBlock({
  title,
  lead,
  slices,
  series,
}: {
  title: string;
  lead: string;
  slices: BreadSlice[];
  series: { label: string; color: string }[];
}) {
  return (
    <section className="ops-dialog-block">
      <h3 className="ops-dialog-block-title">{title}</h3>
      {slices.length === 0 ? (
        <p className="ops-muted">Nothing recorded.</p>
      ) : (
        <SplitBarChart
          rows={slices.map((slice) => ({
            key: slice.key,
            label: slice.name,
            values: [slice.sold, slice.returned],
          }))}
          series={series}
          leadLabel={lead}
          format={formatCount}
        />
      )}
    </section>
  );
}
