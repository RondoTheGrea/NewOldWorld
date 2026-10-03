import { useEffect, useRef, useState } from 'react';

import type { Customer } from '@/context/customers';
import { useInventory } from '@/context/inventory';
import { type CustomerScope } from '@/lib/customer-scope';

export type CustomerScopeState = {
  /** Whether a run is open — i.e. whether there's a crew to filter by at all. */
  hasCrew: boolean;
  /**
   * The open run's crew id, or null. Lets a caller check whether a particular
   * store sits inside the crew (e.g. to decide which scope a selection implies)
   * without re-reading the run.
   */
  crewId: string | null;
  /** The open run's crew name, for the toggle's label and the toast. */
  crewName: string | null;
  /** Forced to `'all'` whenever there's no open run, whatever was last picked. */
  scope: CustomerScope;
  setScope: (scope: CustomerScope) => void;
  /** `customers`, narrowed to the open run's crew unless `scope` is `'all'`. */
  visibleCustomers: Customer[];
};

/**
 * The crew/all store filter shared by the Customers tab and the receipt
 * form's store picker (see CLAUDE.md's "Customer sync" for why a store
 * carries an *optional* crew rather than every store belonging to one).
 *
 * Defaults to the open run's crew — a driver picking a store is almost always
 * picking one on their own route, so starting from "every store on the phone"
 * would put the wrong ones in front of them by default, every truck, every
 * day. With no run open there's no crew to default to, so this always
 * resolves to `'all'` in that case regardless of what was last picked.
 */
export function useCustomerScope(customers: Customer[]): CustomerScopeState {
  const inventory = useInventory();
  // Read from the run, not from setup.agentGroupId or the crew catalog: the
  // run is where the crew was pinned when the day started, and it stays
  // right even if the crew list is re-fetched or edited on the dashboard
  // mid-trip (see InventorySetup's own read of the same field).
  const crewId = inventory.currentRun?.agentGroupId || null;
  const crewName = inventory.currentRun?.agentGroupName || null;
  const hasCrew = !!crewId;

  const [scope, setScope] = useState<CustomerScope>('crew');

  // A run closing, or a different one opening under the same mounted screen,
  // invalidates whatever was picked for the run before it — this defaults
  // back to crew-filtered rather than silently carrying an "All" chosen for
  // a different truck's crew into the next one.
  const lastCrewId = useRef(crewId);
  useEffect(() => {
    if (lastCrewId.current !== crewId) {
      lastCrewId.current = crewId;
      setScope('crew');
    }
  }, [crewId]);

  const effectiveScope: CustomerScope = hasCrew ? scope : 'all';
  const visibleCustomers =
    effectiveScope === 'crew' ? customers.filter((customer) => customer.agentGroupId === crewId) : customers;

  return { hasCrew, crewId, crewName, scope: effectiveScope, setScope, visibleCustomers };
}
