import type { BreadType } from '@/context/bread-types';
import type { ReturnedBreadType } from '@/context/returned-bread-types';
import type { RunHistoryLineItem, RunHistoryMoneyLineItem } from '@/lib/run-history-types';

/**
 * One line of the Run outcome table — what a bread sold, what came back, and
 * what that leaves aboard.
 *
 * The dashboard has the same table, built by the same rules, in
 * `apps/web/src/lib/run-outcome.ts`. The two are deliberate copies while
 * `packages/shared` is empty (see the root CLAUDE.md); the *inputs* differ —
 * the phone reads its own saved history snapshot, the dashboard reads the
 * uploaded run — but the joining and the ordering must not. Change one, change
 * the other.
 */
export type OutcomeRow = {
  name: string;
  sold: number;
  returned: number;
  remaining: number;
};

/**
 * Where a row sits in the table.
 *
 * `order` is the manual position a manager dragged a catalog row to on the
 * dashboard. Bread Types and Returned Bread Types are separate collections but
 * share **one** order namespace — "Copy from Bread Types" on the dashboard's
 * reference-lists page copies the source row's own `order` value verbatim — so
 * the two can be sorted against each other directly.
 *
 * `tier` breaks a tie between them: Bread Types is the main reference, so a
 * returned-only row (an old bread no current bread type is named after) lands
 * *directly below* the bread type holding its position rather than at the
 * bottom of the table. Anything in neither catalog — a bread type since
 * deleted, a return matching nothing — has no position and sorts last,
 * alphabetically.
 */
const Tier = { bread: 0, returned: 1, unknown: 2 } as const;

type RankedRow = OutcomeRow & { order: number; tier: number; tiebreak: number };

type CatalogEntry = { name: string; order: number; tier: number; tiebreak: number };

function indexCatalog(entries: { name: string; order: number }[], tier: number) {
  const byName = new Map<string, CatalogEntry>();
  entries.forEach((entry, index) => {
    // First one wins, so a catalog with the same name twice still yields one
    // row, at the higher of the two positions.
    if (!entry.name || byName.has(entry.name)) return;
    byName.set(entry.name, { name: entry.name, order: entry.order, tier, tiebreak: index });
  });
  return byName;
}

/**
 * Folds a run's saved snapshot into the Run outcome table.
 *
 * **Rows are keyed by name, not by `breadTypeId`, and that is the whole
 * point.** A returned line's id comes from the separate returnedBreadTypes
 * catalog (see `summarizeRunHistoryForRun` in `lib/receipt-db.ts`) and can
 * never equal a bread type's id, so keying on the id split every return onto
 * a row of its own — "Pandesal" sold 40 on one line and "Pandesal" returned 5
 * on another, each telling half the story.
 *
 * The match is **word for word**: the same name is the same row, and anything
 * spelled even slightly differently is a different bread with a row of its
 * own. Fuzzy matching would quietly fold two names a manager typed on purpose
 * into one line; a stray-space name showing up as its own row at the bottom is
 * visible and fixable, a silently merged figure is not.
 *
 * Rows exist only for bread that actually moved — a catalog entry nothing
 * happened to is not a row of zeroes.
 */
export function buildOutcomeRows({
  total,
  sold,
  returned,
  breadTypes,
  returnedBreadTypes,
}: {
  /** What went onto the truck: the initial count plus every batch added. */
  total: RunHistoryLineItem[];
  sold: RunHistoryMoneyLineItem[];
  returned: RunHistoryMoneyLineItem[];
  breadTypes: BreadType[];
  returnedBreadTypes: ReturnedBreadType[];
}): OutcomeRow[] {
  const breadByName = indexCatalog(breadTypes, Tier.bread);
  const returnedByName = indexCatalog(returnedBreadTypes, Tier.returned);

  // `loaded` is only ever subtracted from, so it stays out of the returned row
  // shape and lives here beside it.
  const loaded = new Map<string, number>();
  const rows = new Map<string, RankedRow>();
  const rowFor = (name: string) => {
    const existing = rows.get(name);
    if (existing) return existing;
    const catalog = breadByName.get(name) ?? returnedByName.get(name);
    const row: RankedRow = {
      name,
      order: catalog?.order ?? Number.POSITIVE_INFINITY,
      tier: catalog?.tier ?? Tier.unknown,
      tiebreak: catalog?.tiebreak ?? 0,
      sold: 0,
      returned: 0,
      remaining: 0,
    };
    rows.set(name, row);
    return row;
  };

  for (const item of total) {
    const name = item.name || 'Unnamed bread type';
    rowFor(name);
    loaded.set(name, (loaded.get(name) ?? 0) + item.quantity);
  }
  for (const item of sold) {
    rowFor(item.name || 'Unnamed bread type').sold += item.quantity;
  }
  for (const item of returned) {
    rowFor(item.name || 'Unnamed bread type').returned += item.quantity;
  }

  // Returned bread never goes back on the truck, so what's left is what was
  // loaded minus what was sold — the same subtraction the table did before,
  // just after the rows have been folded together by name.
  for (const row of rows.values()) {
    row.remaining = (loaded.get(row.name) ?? 0) - row.sold;
  }

  return [...rows.values()]
    .sort(
      (a, b) =>
        a.order - b.order || a.tier - b.tier || a.tiebreak - b.tiebreak || a.name.localeCompare(b.name)
    )
    .map(({ name, sold: soldCount, returned: returnedCount, remaining }) => ({
      name,
      sold: soldCount,
      returned: returnedCount,
      remaining,
    }));
}
