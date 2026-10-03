import { type SymbolViewProps } from 'expo-symbols';

// Shared between the customer card and its detail modal, so the same field
// always reads as the same icon in both places.
export const CustomerIcons: Record<
  'contact' | 'deliveryDays' | 'area' | 'crew' | 'address' | 'phone' | 'description',
  SymbolViewProps['name']
> = {
  contact: { ios: 'person.fill', android: 'person', web: 'person' },
  deliveryDays: { ios: 'calendar', android: 'calendar_month', web: 'calendar_month' },
  area: { ios: 'location.fill', android: 'location_on', web: 'location_on' },
  crew: { ios: 'person.3.fill', android: 'groups', web: 'groups' },
  address: { ios: 'mappin.and.ellipse', android: 'home', web: 'home' },
  phone: { ios: 'phone.fill', android: 'call', web: 'call' },
  description: { ios: 'text.alignleft', android: 'notes', web: 'notes' },
};
