import type { BreadType } from '@/lib/bread-types';
import type { ReturnedBreadType } from '@/lib/returned-bread-types';
import { isVoided, type RunReceipt, type StockLine } from '@/lib/runs';

/**
 * One line of the Outcome table — what a bread type sold, what came back, and
 * what the ledger says is still aboard. Shared by the Outcome tab
 * (`run-panel.tsx`) and the Excel export's Bread sheet
 * (`export-run-excel.ts`) so the browser and the downloaded file can never
 * disagree about which rows exist or what order they are in.
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
 * `order` is the manual position a manager dragged a catalog row to. Bread
 * Types and Returned Bread Types are separate collections but share **one**
 * order namespace — "Copy from Bread Types" on the reference-lists page reuses
 * the source row's own `order` value verbatim (see `pages/bread-types.tsx`) —
 * so the two can be sorted against each other directly.
 *
 * `tier` breaks a tie between them, and is the whole point of the sort: Bread
 * Types are the main reference, so a returned-only row (an old bread that no
 * current bread type is named after) lands *directly below* the bread type
 * holding its position rather than at the bottom of the table. Anything in
 * neither catalog — a bread type since deleted, a return whose name matches
 * nothing — has no position at all and sorts last, alphabetically.
 */
const Tier = { bread: 0, returned: 1, unknown: 2 } as const;

type CatalogEntry = { name: string; order: number; tier: number; tiebreak: number };

/** Where a name in neither catalog sits: after everything placed, then by the alphabet. */
const Unplaced: CatalogEntry = { name: '', order: Number.POSITIVE_INFINITY, tier: Tier.unknown, tiebreak: 0 };

function indexCatalog(
  entries: { name: string; order: number }[],
  tier: number,
): Map<string, CatalogEntry> {
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
 * The Outcome table's ordering, on its own: give it the two catalogs and it
 * compares two bread **names** the way that table stacks them.
 *
 * Lifted out of `buildOutcomeRows` (which still uses it, so the two can't
 * drift) because the Trends tab's bread chart shows the same names and the
 * owner asked for the same order — and the ordering rule is subtle enough
 * (`order` shared across two collections, `tier` breaking the tie, a name in
 * neither catalog sorting last) that a second copy of it would be a second
 * thing to get wrong. **This is the one place the dashboard's copy of this file
 * is deliberately not parallel with the phone's**: mobile has no second table
 * to order, so the rule stays inline there.
 *
 * Note the `||` chain rather than a series of `if`s. Two names in neither
 * catalog both rank `Infinity`, and `Infinity - Infinity` is `NaN` — falsy, so
 * the chain falls through to the tier, then the alphabet, which is exactly
 * where those two belong. An `if (a.order !== b.order)` would return `NaN` and
 * leave their order down to the sort implementation.
 */
export function compareBreadNames(
  breadTypes: BreadType[],
  returnedBreadTypes: ReturnedBreadType[],
): (a: string, b: string) => number {
  const breadByName = indexCatalog(breadTypes, Tier.bread);
  const returnedByName = indexCatalog(returnedBreadTypes, Tier.returned);
  const rankOf = (name: string) =>
    breadByName.get(name) ?? returnedByName.get(name) ?? Unplaced;

  return (a, b) => {
    const left = rankOf(a);
    const right = rankOf(b);
    return left.order - right.order || left.tier - right.tier || left.tiebreak - right.tiebreak || a.localeCompare(b);
  };
}

/**
 * Folds this run's ledger and receipts into the Outcome table.
 *
 * The two sides join on a **name**, not an id: sold and remaining come off the
 * ledger keyed by `breadTypeId`, while a return is a write-off that carries no
 * `breadTypeId` at all (see `apps/mobile/CLAUDE.md`, "Returns are a write-off
 * only") — only the name the phone snapshotted onto the receipt. The match is
 * **word for word**: the same name is the same row, and anything spelled even
 * slightly differently is a different bread and gets a row of its own.
 *
 * Rows are only created for bread that actually moved — a catalog entry
 * nothing happened to is not a row of zeroes.
 */
export function buildOutcomeRows({
  stock,
  receipts,
  nameFor,
  breadTypes,
  returnedBreadTypes,
}: {
  stock: StockLine[];
  receipts: RunReceipt[];
  /** Resolves a `breadTypeId` to the name to show — see `buildNameFor`. */
  nameFor: (breadTypeId: string) => string;
  breadTypes: BreadType[];
  returnedBreadTypes: ReturnedBreadType[];
}): OutcomeRow[] {
  const byPosition = compareBreadNames(breadTypes, returnedBreadTypes);

  const rows = new Map<string, OutcomeRow>();
  const rowFor = (name: string) => {
    const existing = rows.get(name);
    if (existing) return existing;
    const row: OutcomeRow = { name, sold: 0, returned: 0, remaining: 0 };
    rows.set(name, row);
    return row;
  };

  for (const line of stock) {
    const row = rowFor(nameFor(line.breadTypeId));
    row.sold += line.sold;
    row.remaining += line.remaining;
  }
  for (const receipt of receipts) {
    // A voided receipt's returns were never credited. Its sold loaves need no
    // skipping here: the ledger's own 'void' entry already took them off.
    if (isVoided(receipt)) continue;
    for (const ret of receipt.returns) {
      const row = rowFor(ret.name || 'Unnamed bread type');
      row.returned += ret.quantity;
    }
  }

  return [...rows.values()].sort((a, b) => byPosition(a.name, b.name));
}

/**
 * Resolves a `breadTypeId` to the name to show — the catalog's spelling first,
 * then the snapshot the phone wrote onto a receipt line. So a bread type the
 * dashboard has since deleted still shows the name it sold under, instead of
 * an id.
 */
export function buildNameFor(breadTypes: BreadType[], receipts: RunReceipt[]) {
  const fromCatalog = new Map(breadTypes.map((type) => [type.id, type.name]));
  const fromReceipts = new Map<string, string>();
  for (const receipt of receipts) {
    for (const item of receipt.items) {
      if (item.name) fromReceipts.set(item.breadTypeId, item.name);
    }
  }
  return (id: string) => fromCatalog.get(id) ?? fromReceipts.get(id) ?? 'Removed bread type';
}
