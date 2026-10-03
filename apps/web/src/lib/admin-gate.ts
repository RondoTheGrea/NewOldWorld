/**
 * The four dashboard-owned catalogs — Bread Types, Areas, Trucks, Agents and
 * the receipt Settings — are readable by every dashboard account but editable
 * only by an administrator (`admin: true` on the `users/{uid}` doc, the same
 * flag that shows the Team page).
 *
 * The Edit button stays on screen for everybody rather than being hidden,
 * because a missing button reads as a broken page: someone who has been told
 * "the prices are on the dashboard" needs to see that the page is the right
 * one and that editing it is somebody else's job. Pressing it says so.
 *
 * This message is the *explanation*, not the protection — firestore.rules
 * requires the same flag on every write to those collections, so a non-admin
 * who gets past this text still can't save anything.
 */
export const ADMIN_ONLY_NOTICE =
  'Only a dashboard administrator can change this. Ask your administrator to make the change, or to give your account administrator access on the Team page.';
