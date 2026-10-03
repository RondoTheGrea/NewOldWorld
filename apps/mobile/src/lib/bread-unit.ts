import { type UnitLabel } from '@/context/bread-types';

/**
 * Stock is tracked and entered in individual pieces, not packaging units —
 * this is just a reminder of how many pieces a tray/box holds, shown next to
 * a bread type wherever its piece count is entered or displayed.
 * e.g. "8 pcs/tray", "12 pcs/box", or "pieces" when there's no larger unit.
 */
export function formatUnitHint(unitSize: number, unitLabel: UnitLabel): string {
  if (unitLabel === 'piece') return 'pieces';
  return `${unitSize} pcs/${unitLabel}`;
}
