/**
 * Whether the store lists on the Customers tab and the receipt form's store
 * picker are narrowed to the open run's crew, or showing every store on the
 * phone. See `hooks/use-customer-scope.ts` for the filtering itself.
 */
export type CustomerScope = 'crew' | 'all';

/**
 * What the transient toast says right after the crew/all toggle is tapped.
 * One wording shared by both surfaces, so a driver reads the same sentence
 * whichever screen they toggled it on.
 */
export function describeCustomerScope(scope: CustomerScope, crewName: string | null): string {
  if (scope === 'all') return 'Showing all stores';
  return crewName ? `Showing ${crewName}’s stores` : 'Showing your crew’s stores';
}
