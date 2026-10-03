/**
 * Fallback business details used only until the dashboard-managed settings
 * doc (Firestore `settings/business`) has loaded at least once — see
 * context/business-settings.tsx. Once a fetch succeeds, or a cached copy
 * from a previous launch exists, these are never shown; they only cover a
 * brand-new install that finishes setup with no internet access at all.
 */
export const DefaultBusinessSettings = {
  name: "Nadean's Marketing",
  contactNumber: '0947-567-7874',
  receiptEndingMessage: 'Thank you for your purchase!',
} as const;
