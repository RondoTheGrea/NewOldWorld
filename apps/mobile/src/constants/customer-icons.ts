import { type SymbolViewProps } from 'expo-symbols';

// Shared between the customer card and its detail modal, so the same field
// always reads as the same icon in both places.
export const CustomerIcons: Record<
  'contact' | 'schedule' | 'address' | 'phone',
  SymbolViewProps['name']
> = {
  contact: { ios: 'person.fill', android: 'person', web: 'person' },
  schedule: { ios: 'calendar', android: 'calendar_month', web: 'calendar_month' },
  address: { ios: 'mappin.and.ellipse', android: 'home', web: 'home' },
  phone: { ios: 'phone.fill', android: 'call', web: 'call' },
};
