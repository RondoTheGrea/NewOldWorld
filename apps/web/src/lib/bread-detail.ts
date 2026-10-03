/**
 * One bread type's period, cut three ways: by crew, by area, and by store.
 *
 * The Trends tab's bread chart answers "what moved"; this answers "who moved
 * it and where", for the one bread a reader clicked. It lives here rather than
 * in `trends-tab.tsx` because it is arithmetic over receipts that both the tab
 * (which builds it) and `bread-detail-dialog.tsx` (which draws it) have to
 * agree on — the same reason `lib/runs.ts` holds the tab's other sums.
 *
 * **Everything here is counted in loaves.** No peso total is carried, exactly
 * as in the section this opens from: the money is General statistics' subject,
 * and a revenue field here would only be a number nothing reads. See "Bread is
 * counted in loaves" in `apps/web/CLAUDE.md`.
 *
 * **It is built in the same pass that builds the chart**, not recomputed when
 * a dialog opens. The join between a sale and a return is on the bread's
 * *name* and a name may be claimed only once (`lib/run-outcome.ts`, and the
 * `breadMovement` memo), so a breakdown assembled separately would have to
 * restate that rule and could drift from it. The cost is three small maps per
 * bread type held whether or not anyone opens a dialog, which at a catalog's
 * worth of bread and a period's worth of stores is nothing.
 */

/**
 * One crew, one area or one store, for one bread.
 *
 * `sold` and `returned` are loaves. `lastDay` is the **stored `businessDay`
 * string** of the most recent receipt that *sold* this bread here — never a
 * day re-derived from a timestamp, and never moved by a return, because the
 * question it answers is "when did they last take it".
 *
 * `lastSeen` is a timestamp and is not displayed: it exists only to decide
 * which spelling of the name to keep when a store or a crew has been renamed
 * inside the period. The newest receipt wins, the same rule the bread rows
 * themselves use.
 */
export type BreadSlice = {
  key: string;
  name: string;
  sold: number;
  returned: number;
  lastDay: string;
  lastSeen: number;
};

/** The three cuts, keyed by crew id, area id and customer id respectively. */
export type BreadBreakdown = {
  crews: Map<string, BreadSlice>;
  areas: Map<string, BreadSlice>;
  stores: Map<string, BreadSlice>;
};

/** The same three cuts once they are finished with: sorted, biggest first. */
export type BreadDetail = {
  crews: BreadSlice[];
  areas: BreadSlice[];
  stores: BreadSlice[];
};

export function emptyBreadBreakdown(): BreadBreakdown {
  return { crews: new Map(), areas: new Map(), stores: new Map() };
}

/**
 * Adds one receipt line to one cut.
 *
 * `back` is what separates a return from a sale, and it does two things at
 * once: it picks the field to add to, and it withholds the `lastDay` update.
 * A store that sent bread back last week hasn't *taken* it since.
 */
export function bumpBreadSlice(
  map: Map<string, BreadSlice>,
  key: string,
  name: string,
  quantity: number,
  back: boolean,
  at: number,
  day: string,
): void {
  const row = map.get(key) ?? { key, name, sold: 0, returned: 0, lastDay: '', lastSeen: 0 };
  if (back) row.returned += quantity;
  else row.sold += quantity;
  if (at >= row.lastSeen) {
    row.lastSeen = at;
    if (name) row.name = name;
  }
  // Business-day keys are `YYYY-MM-DD`, so the later day is the larger string.
  // Compared as strings on purpose: parsing them back into dates would be a
  // second place a timezone could get in.
  if (!back && day > row.lastDay) row.lastDay = day;
  map.set(key, row);
}

/**
 * Folds a bread's returns into its sales, cut by cut.
 *
 * Two maps rather than one because the two sides are keyed differently at
 * their source — a sale carries a `breadTypeId`, a return carries only a name
 * (see "Returns are a write-off only" in `apps/mobile/CLAUDE.md`) — so they
 * can only be brought together once the row they both belong to has been
 * decided. That decision is `breadMovement`'s, and this takes it as given.
 *
 * A slice present on one side only survives: a crew that sent loaves back and
 * sold none is a row with a zero in Sold, not a row that isn't there.
 */
export function mergeBreadSlices(sold: Map<string, BreadSlice>, back?: Map<string, BreadSlice>): BreadSlice[] {
  const merged = new Map<string, BreadSlice>();
  for (const source of [sold, back]) {
    if (!source) continue;
    for (const slice of source.values()) {
      const row = merged.get(slice.key);
      if (!row) {
        merged.set(slice.key, { ...slice });
        continue;
      }
      row.sold += slice.sold;
      row.returned += slice.returned;
      if (slice.lastSeen >= row.lastSeen) {
        row.lastSeen = slice.lastSeen;
        if (slice.name) row.name = slice.name;
      }
      if (slice.lastDay > row.lastDay) row.lastDay = slice.lastDay;
    }
  }
  // Loaves sold first, returns as the tie-break, name last — so a list of
  // stores reads top-down as "who takes the most of this", and the ones that
  // only ever sent it back gather at the bottom where they are the finding.
  return [...merged.values()].sort(
    (a, b) => b.sold - a.sold || b.returned - a.returned || a.name.localeCompare(b.name),
  );
}

/** All three cuts merged at once — what one row of the bread chart opens into. */
export function joinBreadBreakdowns(sold?: BreadBreakdown, back?: BreadBreakdown): BreadDetail {
  const empty = emptyBreadBreakdown();
  const left = sold ?? empty;
  return {
    crews: mergeBreadSlices(left.crews, back?.crews),
    areas: mergeBreadSlices(left.areas, back?.areas),
    stores: mergeBreadSlices(left.stores, back?.stores),
  };
}
